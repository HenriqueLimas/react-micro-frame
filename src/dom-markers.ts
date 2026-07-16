export const markerPrefix = "<!--react-micro-frame:";

export function startMarker(id: string): string {
  return `${markerPrefix}${id}:start-->`;
}

export function endMarker(id: string): string {
  return `${markerPrefix}${id}:end-->`;
}

export function hostElementId(id: string): string {
  return `react-micro-frame-${id}`;
}

export function normalizeReactId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function findMarkers(host: HTMLElement): {
  start: Comment;
  end: Comment;
} {
  let start: Comment | undefined;
  let end: Comment | undefined;

  for (const node of host.childNodes) {
    if (node.nodeType !== Node.COMMENT_NODE) continue;
    const comment = node as Comment;
    if (comment.data.endsWith(":start")) start = comment;
    if (comment.data.endsWith(":end")) end = comment;
  }

  if (!start || !end) {
    throw new Error("Micro-frame host markers are missing.");
  }

  return { start, end };
}

export function clearBetween(start: Comment, end: Comment): void {
  while (start.nextSibling && start.nextSibling !== end) {
    start.parentNode?.removeChild(start.nextSibling);
  }
}
