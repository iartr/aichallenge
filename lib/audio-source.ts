import { AppStoreError, isRecord } from "./db";

const YANDEX_HOSTS = ["disk.yandex.ru", "disk.yandex.com", "disk.yandex.kz", "disk.yandex.by", "yadi.sk"];
const YANDEX_PUBLIC_API = "https://cloud-api.yandex.net/v1/disk/public/resources";
const RESOLVE_TIMEOUT_MS = 20_000;

export type ResolvedMedia = {
  downloadUrl: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
};

/**
 * Turns a user-supplied recording link into a URL AssemblyAI can actually
 * download. Public Yandex.Disk links point at an HTML page, not the file, so we
 * resolve them through the public API to a short-lived direct download href.
 * Plain direct media URLs are passed through untouched.
 */
export async function resolvePublicMediaUrl(rawUrl: string): Promise<ResolvedMedia> {
  const trimmed = rawUrl.trim();

  if (!trimmed) {
    throw new AppStoreError("Ссылка на запись пустая.", 400);
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppStoreError("Ссылка на запись имеет неверный формат.", 400);
  }

  if (!isYandexDiskUrl(parsed)) {
    return { downloadUrl: trimmed };
  }

  return resolveYandexDisk(trimmed);
}

export function isYandexDiskUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();

  return YANDEX_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

async function resolveYandexDisk(publicUrl: string): Promise<ResolvedMedia> {
  const meta = await fetchYandexJson(`${YANDEX_PUBLIC_API}?public_key=${encodeURIComponent(publicUrl)}&limit=200`);

  if (!isRecord(meta)) {
    throw new AppStoreError("Не удалось прочитать ответ Яндекс.Диска.", 502);
  }

  if (meta.type === "file") {
    return toResolvedMedia(meta, await resolveYandexDownloadHref(publicUrl));
  }

  const embedded = isRecord(meta._embedded) ? meta._embedded : null;
  const items = embedded && Array.isArray(embedded.items) ? embedded.items : [];
  const mediaItem = items.find(
    (item): item is Record<string, unknown> => isRecord(item) && (item.media_type === "audio" || item.media_type === "video"),
  );

  if (!mediaItem) {
    throw new AppStoreError("В папке по ссылке нет аудио- или видеофайла для разбора.", 400);
  }

  const path = typeof mediaItem.path === "string" ? mediaItem.path : "";

  return toResolvedMedia(mediaItem, await resolveYandexDownloadHref(publicUrl, path));
}

async function resolveYandexDownloadHref(publicUrl: string, path?: string): Promise<string> {
  const url = new URL(`${YANDEX_PUBLIC_API}/download`);
  url.searchParams.set("public_key", publicUrl);

  if (path) {
    url.searchParams.set("path", path);
  }

  const data = await fetchYandexJson(url.toString());

  if (!isRecord(data) || typeof data.href !== "string" || !data.href) {
    throw new AppStoreError("Яндекс.Диск не вернул прямую ссылку на файл.", 502);
  }

  return data.href;
}

function toResolvedMedia(meta: Record<string, unknown>, downloadUrl: string): ResolvedMedia {
  return {
    downloadUrl,
    fileName: typeof meta.name === "string" ? meta.name : undefined,
    mimeType: typeof meta.mime_type === "string" ? meta.mime_type : undefined,
    sizeBytes: typeof meta.size === "number" ? meta.size : undefined,
  };
}

async function fetchYandexJson(url: string): Promise<unknown> {
  let response: Response;

  try {
    response = await fetch(url, { signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "запрос не удался";
    throw new AppStoreError(`Не удалось обратиться к Яндекс.Диску: ${message}`, 504);
  }

  const text = await response.text();
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new AppStoreError("Файл по ссылке не найден. Проверь, что ссылка публичная и не была удалена.", 400);
    }

    const description = isRecord(parsed) && typeof parsed.description === "string" ? parsed.description : `статус ${response.status}`;
    throw new AppStoreError(`Яндекс.Диск вернул ошибку: ${description}`, 502);
  }

  return parsed;
}
