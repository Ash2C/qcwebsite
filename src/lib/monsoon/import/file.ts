// Bulk import: one chosen file (CSV or .xlsx) read in the browser into a header and rows. The file
// never leaves the device as a file. Every failure is an ImportFileError worded for the person.
import { ImportFileError, checkSize, parseCsv, toTable, type Table } from "./parse";
import { readXlsx } from "./xlsx";

export const UNREADABLE = "Monsoon could not read this file. Save it as CSV and try again.";
export const OLD_FORMAT = "Save the spreadsheet as CSV or .xlsx first.";

// Spreadsheet formats this does not read, by the end of the file's name.
const OLD_ENDINGS = [".xls", ".xlsb", ".numbers", ".ods"];

function readBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  // Older browsers have no Blob.arrayBuffer.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsArrayBuffer(file);
  });
}

const startsWith = (bytes: Uint8Array, ...head: number[]): boolean => head.every((b, i) => bytes[i] === b);

/** The file's text: UTF-16 when it says so, UTF-8 when it is valid UTF-8, else the old Windows encoding. */
function decode(bytes: Uint8Array): string {
  if (startsWith(bytes, 0xff, 0xfe)) return new TextDecoder("utf-16le").decode(bytes);
  if (startsWith(bytes, 0xfe, 0xff)) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** The header and data rows of a chosen file. Checks the size before reading anything. */
export async function readImportFile(file: File): Promise<Table> {
  const name = (file.name ?? "").toLowerCase();
  if (OLD_ENDINGS.some((ending) => name.endsWith(ending))) throw new ImportFileError(OLD_FORMAT);
  checkSize(file.size);
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(file);
  } catch {
    throw new ImportFileError(UNREADABLE);
  }
  // An old Excel file (or a password-protected one), whatever it is called.
  if (startsWith(bytes, 0xd0, 0xcf, 0x11, 0xe0)) throw new ImportFileError(OLD_FORMAT);

  let rows: string[][];
  if (name.endsWith(".xlsx") || startsWith(bytes, 0x50, 0x4b, 0x03, 0x04)) {
    try {
      rows = await readXlsx(bytes);
    } catch {
      throw new ImportFileError(UNREADABLE);
    }
  } else {
    let text: string;
    try {
      text = decode(bytes);
    } catch {
      throw new ImportFileError(UNREADABLE);
    }
    // Text files hold no NUL characters: this is some other kind of file.
    if (text.includes(String.fromCharCode(0))) throw new ImportFileError(UNREADABLE);
    rows = parseCsv(text);
  }
  return toTable(rows);
}
