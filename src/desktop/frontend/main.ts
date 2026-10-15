import logoUrl from "../../../public/apple-touch-icon-trader-v6.png?url";
import "./loading.css";

const logo = document.querySelector<HTMLImageElement>("#logo");
if (logo) logo.src = logoUrl;

if (navigator.language.toLowerCase().startsWith("ja")) {
  document.documentElement.lang = "ja";
  const status = document.querySelector<HTMLElement>("#status");
  if (status) status.textContent = "ローカルワークスペースを起動しています…";
}
