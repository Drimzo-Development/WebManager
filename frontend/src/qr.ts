// The QR generator is the vendored script (public/assets/vendor/qrcode.js, MIT); it is loaded on demand.
interface QrCode {
  addData(text: string): void;
  make(): void;
  createDataURL(cellSize: number, margin: number): string;
}
type QrFactory = (typeNumber: number, level: 'L' | 'M' | 'Q' | 'H') => QrCode;

let loading: Promise<QrFactory> | null = null;

function loadQr(): Promise<QrFactory> {
  loading ??= new Promise<QrFactory>((resolve, reject) => {
    const have = (window as unknown as { qrcode?: QrFactory }).qrcode;
    if (have) return resolve(have);
    const s = document.createElement('script');
    s.src = '/assets/vendor/qrcode.js';
    s.onload = () => {
      const f = (window as unknown as { qrcode?: QrFactory }).qrcode;
      f ? resolve(f) : reject(new Error('QR code generation not available'));
    };
    s.onerror = () => {
      loading = null;
      reject(new Error('QR code generation could not be loaded'));
    };
    document.head.append(s);
  });
  return loading;
}

/** PNG data URL for the text (error correction M, picks the smallest version that fits). */
export async function qrDataUrl(text: string): Promise<string> {
  const qr = (await loadQr())(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(5, 8);
}
