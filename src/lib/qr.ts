import QRCode from "qrcode";

/**
 * Renders an order token as an SVG data URL.
 *
 * QRCode.toDataURL() rasterises through a canvas, which workerd has no
 * implementation of — on Workers it throws "You need to specify a canvas
 * element" and fails the whole request. toString({ type: "svg" }) is pure
 * string building, so it runs anywhere, and the result scales better on the
 * phone screens students actually present at the counter.
 */
export async function qrDataUrl(token: string): Promise<string> {
  const svg = await QRCode.toString(token, { type: "svg", margin: 1, width: 256 });
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
