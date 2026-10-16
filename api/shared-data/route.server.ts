import { providerEnvironment } from "../../src/app/platform/provider-environment.server";
import { isSharedDataId } from "../../src/app/platform/shared-data-contracts";
import { createSharedDataClient, SharedDataError } from "./client.server";

export async function getSharedDatasetResponse(request: Request, datasetId: string): Promise<Response> {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  if (!isSharedDataId(datasetId)) return Response.json({ error: { code: "unknown_dataset", message: "Unknown shared dataset." } }, { status: 404, headers });
  try {
    const result = await createSharedDataClient(providerEnvironment()).get(datasetId, new URL(request.url).searchParams, request.signal);
    return Response.json(result, { headers });
  } catch (error) {
    const failure = error instanceof SharedDataError ? error : new SharedDataError("unavailable");
    const message = failure.status === 400 ? "取得条件を確認してください。"
      : failure.code === "shared_cursor_revision_changed" ? "共有データの公開版が変わりました。先頭ページから取得し直してください。"
        : failure.status === 409 ? "共有データの公開状態を検証できません。公開処理の完了後に取得し直してください。"
        : failure.code === "configuration_required" ? "Traderの共有データ取得サービスを設定してください。"
          : "共有データを取得できませんでした。保存先・公開状態・取得範囲を確認してください。";
    return Response.json({ error: { code: failure.code, message } }, { status: failure.status, headers });
  }
}
