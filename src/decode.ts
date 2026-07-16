export async function* decodeReadableStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) yield text;
    }

    const remainder = decoder.decode();
    if (remainder) yield remainder;
  } finally {
    reader.releaseLock();
  }
}
