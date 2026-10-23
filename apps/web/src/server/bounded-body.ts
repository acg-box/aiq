/** Read one byte stream, cancel it on overflow, and release its reader. */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Stream reads must remain sequential.
      const result = await reader.read();
      if (result.done) break;
      bytesRead += result.value.byteLength;
      if (bytesRead > maximumBytes) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Cancel before releasing this reader.
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
    return new Uint8Array(Buffer.concat(chunks, bytesRead));
  } finally {
    reader.releaseLock();
  }
}
