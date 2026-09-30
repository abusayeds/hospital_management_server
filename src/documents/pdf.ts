import fs from "fs";
import path from "path";
import type { Browser } from "puppeteer";
import { env } from "../config/env";
import AppError from "../errors/AppError";
import { logger } from "../utils/logger";

/**
 * PDF RENDERING — HTML in, PDF out, using headless Chrome (Puppeteer).
 *
 * Why a browser: Bangla needs proper text shaping (conjuncts like "ক্ষ", vowel signs placed
 * before the consonant). Chrome's shaping engine does this correctly; simple PDF libraries do not.
 * The Hind Siliguri font is embedded in the HTML (base64), so no network is needed and the
 * PDF looks the same on every machine. One browser is shared; each render uses its own page.
 */

let browserPromise: Promise<Browser> | null = null;

const launch = async (): Promise<Browser> => {
  const puppeteer = (await import("puppeteer")).default;
  return puppeteer.launch({
    headless: "shell",
    executablePath: env.PDF_BROWSER_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
};

const getBrowser = () => {
  browserPromise ??= launch().catch((err) => {
    browserPromise = null;
    logger.error({ err }, "Could not start the PDF browser");
    throw new AppError(
      503,
      "PDF printing is not set up on the server. Run `npm run pdf:setup` in backend/ (or set PDF_BROWSER_PATH).",
      "INTERNAL_ERROR",
    );
  });
  return browserPromise;
};

export const renderPdf = async (html: string, opts: { format?: "A4" | "A5" } = {}): Promise<Buffer> => {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // No scripts and no network: the HTML is self-contained
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().startsWith("data:") ? r.continue() : r.abort()));
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluateHandle("document.fonts.ready").catch(() => undefined);
    const pdf = await page.pdf({
      format: opts.format ?? "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "14mm", left: "12mm", right: "12mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
};

export const closePdfBrowser = async () => {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  await b?.close().catch(() => undefined);
};

// ------------------------------------------------------------------ fonts

const FONT_DIR = path.join(process.cwd(), "node_modules/@fontsource/hind-siliguri/files");
let fontCss: string | null = null;

/** @font-face rules with the font files inlined (read once, then cached) */
export const embeddedFontCss = () => {
  fontCss ??= [400, 600, 700]
    .flatMap((weight) =>
      ["bengali", "latin"].map((subset) => {
        const file = path.join(FONT_DIR, `hind-siliguri-${subset}-${weight}-normal.woff2`);
        const data = fs.readFileSync(file).toString("base64");
        return `@font-face{font-family:"Hind Siliguri";font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${data}) format("woff2");}`;
      }),
    )
    .join("\n");
  return fontCss;
};

/** Escape text for HTML (all record content goes through this) */
export const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
