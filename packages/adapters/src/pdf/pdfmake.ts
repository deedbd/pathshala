import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { PdfAdapter } from '../interfaces.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

interface PdfmakeServer {
  addFonts(fonts: Record<string, Record<string, string>>): void;
  setLocalAccessPolicy(cb: (p: string) => boolean): void;
  setUrlAccessPolicy?(cb: (url: string) => boolean): void;
  createPdf(doc: unknown): { getBuffer(): Promise<Buffer> };
  virtualfs: { writeFileSync(name: string, content: Buffer | string): void; existsSync(name: string): boolean };
}

/**
 * pdfmake 0.3 on the server (pure JS). Fonts: `packages/adapters/fonts/` ships Noto Sans Bengali + IBM Plex
 * Sans (see fonts/README.md); pdfmake's bundled Roboto is always registered as a Latin fallback.
 * Default font is Noto Sans Bengali when present so Bangla report cards render on shared hosting.
 */
export class PdfmakePdf implements PdfAdapter {
  readonly kind = 'pdfmake';
  private lib: PdfmakeServer | null = null;
  private fontsDir: string;
  private defaultFont = 'Roboto';

  constructor(fontsDir?: string) { this.fontsDir = fontsDir ?? path.resolve(here, '../../fonts'); }

  private load(): PdfmakeServer {
    if (this.lib) return this.lib;
    const pdfmake = require('pdfmake') as PdfmakeServer;
    // pdfmake 0.3 resolves font entries by name through its virtual file system; register the TTFs there.
    const fonts: Record<string, Record<string, string>> = {};
    const f = (name: string) => path.join(this.fontsDir, name);
    const has = (name: string) => fs.existsSync(f(name));
    const family = (key: string, regular: string, bold: string) => {
      if (!has(regular)) return false;
      pdfmake.virtualfs.writeFileSync(regular, fs.readFileSync(f(regular)));
      const b = has(bold) ? bold : regular;
      if (b === bold) pdfmake.virtualfs.writeFileSync(bold, fs.readFileSync(f(bold)));
      fonts[key] = { normal: regular, bold: b, italics: regular, bolditalics: b };
      return true;
    };
    if (family('NotoSansBengali', 'NotoSansBengali-Regular.ttf', 'NotoSansBengali-Bold.ttf')) this.defaultFont = 'NotoSansBengali';
    if (family('IBMPlexSans', 'IBMPlexSans-Regular.ttf', 'IBMPlexSans-Bold.ttf') && this.defaultFont === 'Roboto') this.defaultFont = 'IBMPlexSans';
    try {
      const vfs = require('pdfmake/build/vfs_fonts.js') as Record<string, string>;
      if (vfs['Roboto-Regular.ttf']) {
        for (const n of ['Roboto-Regular.ttf', 'Roboto-Medium.ttf', 'Roboto-Italic.ttf', 'Roboto-MediumItalic.ttf']) if (vfs[n] && !pdfmake.virtualfs.existsSync(n)) pdfmake.virtualfs.writeFileSync(n, Buffer.from(vfs[n], 'base64'));
        fonts.Roboto = { normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf', italics: 'Roboto-Italic.ttf', bolditalics: 'Roboto-MediumItalic.ttf' };
      }
    } catch { /* no bundled fonts in this pdfmake build */ }
    if (!Object.keys(fonts).length) throw new Error('no PDF fonts available: add TTFs to packages/adapters/fonts');
    if (!fonts[this.defaultFont]) this.defaultFont = Object.keys(fonts)[0];
    pdfmake.addFonts(fonts);
    pdfmake.setLocalAccessPolicy(() => false); // fonts/images come from buffers, never from arbitrary paths
    pdfmake.setUrlAccessPolicy?.(() => false); // a document must never fetch a remote asset while rendering
    this.lib = pdfmake;
    return pdfmake;
  }

  async render(doc: Record<string, unknown>, opts?: { fontFamily?: string }): Promise<Buffer> {
    const lib = this.load();
    const def = { ...doc, defaultStyle: { font: opts?.fontFamily ?? this.defaultFont, fontSize: 10, ...((doc.defaultStyle as object) ?? {}) } };
    return lib.createPdf(def).getBuffer();
  }
}
