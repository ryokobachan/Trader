use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, RwLock,
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;
use tauri::{
    webview::NewWindowResponse, AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder,
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const RUNTIME_BINARY: &str = "unicorn-runtime";
const MARKET_BINARY: &str = "unicorn-market-sidecar";

#[derive(Default)]
struct DesktopProcesses {
    children: Mutex<Vec<Child>>,
    shutting_down: AtomicBool,
}

#[derive(Clone, Default)]
struct NavigationPolicy(Arc<RwLock<Option<u16>>>);

impl NavigationPolicy {
    fn allow_runtime_port(&self, port: u16) {
        *self.0.write().expect("navigation policy lock poisoned") = Some(port);
    }

    fn allows(&self, url: &Url) -> bool {
        if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
            return true;
        }
        url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port().is_some()
            && *self.0.read().expect("navigation policy lock poisoned") == url.port()
    }
}

impl DesktopProcesses {
    fn push(&self, child: Child) {
        self.children
            .lock()
            .expect("desktop process lock poisoned")
            .push(child);
    }

    fn terminate_all(&self) {
        let mut children = self.children.lock().expect("desktop process lock poisoned");
        for child in children.iter_mut().rev() {
            terminate_child(child);
        }
        children.clear();
    }

    fn begin_shutdown(&self) -> bool {
        !self.shutting_down.swap(true, Ordering::SeqCst)
    }

    fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }
}

#[cfg(unix)]
fn terminate_child(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }

    // Both bundled helpers handle SIGTERM and close SQLite/network resources.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    // A helper can own multiprocessing descendants. Kill the whole process
    // group on timeout so a frozen Python worker cannot outlive the app.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.wait();
}

#[cfg(not(unix))]
fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn binary_path(name: &str) -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("could not locate desktop executable: {error}"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| "desktop executable has no parent directory".to_string())?;
    let path = directory.join(name);
    if !path.is_file() {
        return Err(format!("required bundled helper is missing: {name}"));
    }
    Ok(path)
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("could not generate token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn available_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("could not reserve loopback port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("could not read loopback port: {error}"))
}

fn sidecar_is_healthy(port: u16, token: &str) -> bool {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let Ok(mut stream) = TcpStream::connect_timeout(&address.into(), Duration::from_millis(400))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let request = format!(
        "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = Vec::with_capacity(4_096);
    let mut buffer = [0_u8; 4_096];
    while response.len() < 16_384 {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                response.extend_from_slice(&buffer[..count]);
                if response
                    .windows(b"unicorn.tradingview-sidecar.v1".len())
                    .any(|window| window == b"unicorn.tradingview-sidecar.v1")
                {
                    break;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                break;
            }
            Err(_) => return false,
        }
    }
    let response = String::from_utf8_lossy(&response);
    (response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200"))
        && response.contains("unicorn.tradingview-sidecar.v1")
}

fn wait_for_sidecar(port: u16, token: &str, child: &mut Child) -> bool {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return false;
        }
        if sidecar_is_healthy(port, token) {
            return true;
        }
        thread::sleep(Duration::from_millis(120));
    }
    false
}

fn start_market_sidecar(log_path: &Path) -> Result<(Child, u16, String), String> {
    let port = available_loopback_port()?;
    let token = random_token()?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|error| format!("could not open desktop log: {error}"))?;
    let mut child = Command::new(binary_path(MARKET_BINARY)?)
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--timeout",
            "20",
        ])
        .env("UNICORN_TRADINGVIEW_SIDECAR_TOKEN", &token)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .process_group(0)
        .spawn()
        .map_err(|error| format!("could not start market helper: {error}"))?;

    if wait_for_sidecar(port, &token, &mut child) {
        Ok((child, port, token))
    } else {
        terminate_child(&mut child);
        Err("market helper did not become ready".to_string())
    }
}

fn validated_bootstrap_url(value: &Value) -> Result<Url, String> {
    if value.get("type").and_then(Value::as_str) != Some("unicorn-desktop-ready") {
        return Err("desktop runtime returned an unknown readiness event".to_string());
    }
    let origin = value
        .get("origin")
        .and_then(Value::as_str)
        .ok_or_else(|| "desktop runtime omitted its origin".to_string())?
        .parse::<Url>()
        .map_err(|_| "desktop runtime returned an invalid origin".to_string())?;
    let bootstrap = value
        .get("bootstrapUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "desktop runtime omitted its bootstrap URL".to_string())?
        .parse::<Url>()
        .map_err(|_| "desktop runtime returned an invalid bootstrap URL".to_string())?;

    let same_loopback_origin = origin.scheme() == "http"
        && origin.host_str() == Some("127.0.0.1")
        && origin.username().is_empty()
        && origin.password().is_none()
        && origin.port().is_some()
        && bootstrap.scheme() == origin.scheme()
        && bootstrap.host_str() == origin.host_str()
        && bootstrap.port() == origin.port()
        && bootstrap.username().is_empty()
        && bootstrap.password().is_none()
        && bootstrap
            .path()
            .strip_prefix("/__unicorn_desktop_bootstrap/")
            .is_some_and(|token| {
                token.len() == 32 && token.chars().all(|value| value.is_ascii_hexdigit())
            })
        && bootstrap.query().is_none()
        && bootstrap.fragment().is_none();
    if !same_loopback_origin {
        return Err("desktop runtime readiness URL failed validation".to_string());
    }
    Ok(bootstrap)
}

fn read_runtime_ready(stdout: impl Read + Send + 'static) -> Result<Url, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if !sent && value.get("type").and_then(Value::as_str) == Some("unicorn-desktop-ready") {
                let _ = sender.send(validated_bootstrap_url(&value));
                sent = true;
            }
        }
    });
    receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "desktop runtime did not become ready".to_string())?
}

fn start_runtime(
    resource_dir: &Path,
    database_path: &Path,
    log_path: &Path,
    market: Option<(u16, &str)>,
) -> Result<(Child, Url), String> {
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|error| format!("could not open desktop log: {error}"))?;
    let mut command = Command::new(binary_path(RUNTIME_BINARY)?);
    command
        .args(["--root", &resource_dir.to_string_lossy()])
        .args(["--port", "0"])
        .args(["--database", &database_path.to_string_lossy()])
        .env("UNICORN_USAGE_MODE", "personal")
        .env("UNICORN_ENABLE_YAHOO_COMPAT", "true")
        .env("UNICORN_INSTRUMENT_PROVIDER", "yahoo")
        .env("UNICORN_PROFILE_PROVIDER", "yahoo")
        .env("UNICORN_FUNDAMENTALS_PROVIDER", "yahoo")
        .env("UNICORN_EARNINGS_PROVIDER", "yahoo")
        .env("UNICORN_ANALYST_PROVIDER", "benzinga")
        .env("UNICORN_NEWS_PROVIDER", "yahoo")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log))
        .process_group(0);
    if cfg!(debug_assertions) {
        command.env("UNICORN_DESKTOP_DEBUG", "1");
    }

    if let Some((port, token)) = market {
        command
            .env("UNICORN_MARKET_PROVIDER", "tradingview-websocket")
            .env("UNICORN_BARS_PROVIDER", "tradingview-websocket")
            .env(
                "UNICORN_TRADINGVIEW_SIDECAR_URL",
                format!("http://127.0.0.1:{port}"),
            )
            .env("UNICORN_TRADINGVIEW_SIDECAR_TOKEN", token)
            .env("UNICORN_TRADINGVIEW_SIDECAR_TIMEOUT_MS", "25000")
            .env("UNICORN_TRADINGVIEW_MAX_CANDLES", "10000");
    } else {
        command
            .env("UNICORN_MARKET_PROVIDER", "yahoo")
            .env("UNICORN_BARS_PROVIDER", "yahoo");
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start desktop runtime: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "desktop runtime stdout was unavailable".to_string())?;
    match read_runtime_ready(stdout) {
        Ok(url) => Ok((child, url)),
        Err(error) => {
            terminate_child(&mut child);
            Err(error)
        }
    }
}

fn show_startup_failure(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(
            "document.querySelector('#status').textContent = navigator.language.toLowerCase().startsWith('ja') ? '起動できませんでした。Unicornを終了して、もう一度開いてください。' : 'Unicorn could not start. Quit the app and open it again.'; document.querySelector('.spinner').hidden = true;",
        );
    }
}

fn launch_desktop(app: AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve app data directory: {error}"))?;
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("could not create app data directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("could not secure app data directory: {error}"))?;
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("could not resolve resource directory: {error}"))?;
    let database_path = data_dir.join("unicorn.sqlite3");
    let log_path = data_dir.join("unicorn-desktop.log");
    let processes = app.state::<DesktopProcesses>();
    if processes.is_shutting_down() {
        return Err("desktop app is shutting down".to_string());
    }

    let mut market_child = None;
    let market = match start_market_sidecar(&log_path) {
        Ok((child, port, token)) => {
            if processes.is_shutting_down() {
                let mut child = child;
                terminate_child(&mut child);
                return Err("desktop app is shutting down".to_string());
            }
            market_child = Some(child);
            Some((port, token))
        }
        Err(error) => {
            eprintln!("Unicorn market helper unavailable; using Yahoo polling: {error}");
            None
        }
    };
    let market_reference = market.as_ref().map(|(port, token)| (*port, token.as_str()));
    let (runtime, bootstrap_url) =
        match start_runtime(&resource_dir, &database_path, &log_path, market_reference) {
            Ok(result) => result,
            Err(error) => {
                if let Some(mut child) = market_child.take() {
                    terminate_child(&mut child);
                }
                return Err(error);
            }
        };
    if processes.is_shutting_down() {
        let mut runtime = runtime;
        terminate_child(&mut runtime);
        if let Some(mut child) = market_child.take() {
            terminate_child(&mut child);
        }
        return Err("desktop app is shutting down".to_string());
    }
    if let Some(child) = market_child {
        processes.push(child);
    }
    processes.push(runtime);

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window was unavailable".to_string())?;
    let port = bootstrap_url
        .port()
        .ok_or_else(|| "desktop runtime URL omitted its port".to_string())?;
    app.state::<NavigationPolicy>().allow_runtime_port(port);
    window
        .navigate(bootstrap_url)
        .map_err(|error| format!("could not open desktop workspace: {error}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let navigation_policy = NavigationPolicy::default();
    let app = tauri::Builder::default()
        .manage(DesktopProcesses::default())
        .manage(navigation_policy.clone())
        .setup(|app| {
            let navigation_guard = app.state::<NavigationPolicy>().inner().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Unicorn")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 700.0)
                .center()
                .resizable(true)
                .on_navigation(move |url| navigation_guard.allows(url))
                .on_new_window(|url, _features| {
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = Command::new("/usr/bin/open")
                            .arg(url.as_str())
                            .stdin(Stdio::null())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .spawn();
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            let handle = app.handle().clone();
            thread::spawn(move || {
                if let Err(error) = launch_desktop(handle.clone()) {
                    eprintln!("Unicorn desktop startup failed: {error}");
                    show_startup_failure(&handle);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Unicorn");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            let processes = app_handle.state::<DesktopProcesses>();
            if processes.begin_shutdown() {
                api.prevent_exit();
                let handle = app_handle.clone();
                thread::spawn(move || {
                    handle.state::<DesktopProcesses>().terminate_all();
                    handle.exit(code.unwrap_or(0));
                });
            }
        }
        RunEvent::Exit => app_handle.state::<DesktopProcesses>().terminate_all(),
        _ => {}
    });
}
