// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readImportFile } from "./file";
import { ImportFileError } from "./parse";
import { readXlsx } from "./xlsx";

void React;

const WORKBOOK = (sheets: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`;
const RELS = (rels: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
const SHEET = (rows: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
const STRINGS = (items: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${items.join("")}</sst>`;
// Style 0 is General, style 1 a built-in date, style 2 a custom date format, style 3 a custom number format.
const STYLES = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="dd\\ mmm\\ yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00&quot;d&quot;"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`;

function book(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(files)) entries[name] = strToU8(text);
  return zipSync(entries);
}

const SIMPLE = {
  "xl/workbook.xml": WORKBOOK('<sheet name="People" sheetId="1" r:id="rId1"/>'),
  "xl/_rels/workbook.xml.rels": RELS('<Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/>'),
  "xl/sharedStrings.xml": STRINGS([
    "<si><t>Name</t></si>",
    "<si><t>Email</t></si>",
    "<si><t>Connected On</t></si>",
    '<si><r><t>Jane </t></r><r><t xml:space="preserve">Tan</t></r><rPh><t>phonetic</t></rPh></si>',
  ]),
  "xl/styles.xml": STYLES,
  "xl/worksheets/sheet1.xml": SHEET(
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="C2" s="1"><v>44267</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Raj Rao</t></is></c><c r="B3" t="str"><f>A1</f><v>raj@x.com</v></c><c r="C3" s="2"><v>44267.75</v></c></row>' +
      '<row r="4"><c r="A4"><v>1.4155550123E10</v></c><c r="B4" t="b"><v>1</v></c><c r="C4" s="3"><v>12.5</v></c><c r="D4" t="e"><v>#N/A</v></c></row>',
  ),
};

describe("readXlsx", () => {
  it("reads shared, inline and formula strings, leaves gaps empty, and writes dates as days", async () => {
    expect(await readXlsx(book(SIMPLE))).toEqual([
      ["Name", "Email", "Connected On"],
      ["Jane Tan", "", "2021-03-12"],
      ["Raj Rao", "raj@x.com", "2021-03-12"],
      ["14155550123", "TRUE", "12.5", ""],
    ]);
  });

  it("reads the first sheet of the workbook, wherever its file is", async () => {
    const bytes = book({
      "xl/workbook.xml": WORKBOOK('<sheet name="First" sheetId="5" r:id="rId9"/><sheet name="Second" sheetId="1" r:id="rId1"/>'),
      "xl/_rels/workbook.xml.rels": RELS(
        '<Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="x" Target="/xl/worksheets/sheet7.xml"/>',
      ),
      "xl/worksheets/sheet1.xml": SHEET('<row r="1"><c r="A1" t="inlineStr"><is><t>wrong</t></is></c></row>'),
      "xl/worksheets/sheet7.xml": SHEET('<row r="1"><c r="A1" t="inlineStr"><is><t>right</t></is></c></row>'),
    });
    expect(await readXlsx(bytes)).toEqual([["right"]]);
  });

  it("a formula or a script in a cell is only text", async () => {
    const bytes = book({
      ...SIMPLE,
      "xl/worksheets/sheet1.xml": SHEET(
        '<row r="1"><c r="A1" t="inlineStr"><is><t>=HYPERLINK("http://x")</t></is></c><c r="B1" t="inlineStr"><is><t>&lt;script&gt;alert(1)&lt;/script&gt;</t></is></c></row>',
      ),
    });
    expect(await readXlsx(bytes)).toEqual([['=HYPERLINK("http://x")', "<script>alert(1)</script>"]]);
  });

  it("refuses bytes that are not a workbook", async () => {
    await expect(readXlsx(strToU8("not a zip"))).rejects.toThrow();
    await expect(readXlsx(zipSync({ "hello.txt": strToU8("hi") }))).rejects.toThrow();
  });
});

const csvFile = (text: string, name = "people.csv") => new File([text], name, { type: "text/csv" });

describe("readImportFile", () => {
  it("reads a CSV file into its header and rows", async () => {
    const table = await readImportFile(csvFile("﻿Name,Email\nJane Tan,j@x.com\nRaj Rao,\n"));
    expect(table.headers).toEqual(["Name", "Email"]);
    expect(table.rows).toEqual([
      ["Jane Tan", "j@x.com"],
      ["Raj Rao", ""],
    ]);
  });

  it("reads an .xlsx file", async () => {
    const table = await readImportFile(new File([book(SIMPLE) as BlobPart], "people.xlsx"));
    expect(table.headers).toEqual(["Name", "Email", "Connected On"]);
    expect(table.rows[0]).toEqual(["Jane Tan", "", "2021-03-12"]);
  });

  it("reads a CSV saved in the old Windows encoding", async () => {
    // "José" with é as the single byte 0xE9, which is not valid UTF-8.
    const bytes = new Uint8Array([...strToU8("Name,Email\nJos"), 0xe9, ...strToU8(",j@x.com\n")]);
    const table = await readImportFile(new File([bytes], "old.csv"));
    expect(table.rows[0][0]).toBe("José");
  });

  it("reads a UTF-16 file with a byte order mark", async () => {
    const text = "Name\tEmail\nJane Tan\tj@x.com\n";
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < text.length; i++) bytes[2 + i * 2] = text.charCodeAt(i);
    const table = await readImportFile(new File([bytes], "export.csv"));
    expect(table.headers).toEqual(["Name", "Email"]);
    expect(table.rows).toEqual([["Jane Tan", "j@x.com"]]);
  });

  it("tells the person to save an old spreadsheet differently", async () => {
    for (const name of ["old.xls", "people.numbers", "sheet.ods", "OLD.XLS"]) {
      await expect(readImportFile(new File(["x"], name))).rejects.toThrow("Save the spreadsheet as CSV or .xlsx first.");
    }
    // An old Excel file under another name is known by its first bytes.
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(readImportFile(new File([ole], "people.csv"))).rejects.toThrow("Save the spreadsheet as CSV or .xlsx first.");
  });

  it("says so plainly when the file cannot be read", async () => {
    const broken = readImportFile(new File([strToU8("PK\u0003\u0004 this is not really a zip")], "people.xlsx"));
    await expect(broken).rejects.toThrow("Monsoon could not read this file. Save it as CSV and try again.");
    await expect(broken).rejects.toBeInstanceOf(ImportFileError);
    const binary = new Uint8Array([1, 2, 0, 0, 0, 3, 4, 0, 0, 9]);
    await expect(readImportFile(new File([binary], "people.csv"))).rejects.toThrow("Monsoon could not read this file. Save it as CSV and try again.");
  });

  it("refuses a file that is too big before reading it, and one with too many rows", async () => {
    const big = { name: "big.csv", size: 10 * 1024 * 1024 + 1, arrayBuffer: () => Promise.reject(new Error("must not be read")) } as unknown as File;
    await expect(readImportFile(big)).rejects.toThrow("This file is larger than 10 MB.");
    const many = "Name\n" + Array.from({ length: 5001 }, (_, i) => `Person ${i}`).join("\n");
    await expect(readImportFile(csvFile(many))).rejects.toThrow("This file has more than 5,000 rows.");
  });
});
