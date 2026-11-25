import { describe, expect, it } from "vitest";
import { ImportFileError, MAX_BYTES, MAX_ROWS, checkSize, findHeaderRow, parseCsv, sourceName, toTable } from "./parse";

describe("parseCsv", () => {
  it("reads plain rows", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("reads quoted fields with commas, doubled quotes and line breaks inside", () => {
    const text = 'Name,Notes\n"Tan, Jane","She said ""hello""\nand left"\n';
    expect(parseCsv(text)).toEqual([
      ["Name", "Notes"],
      ["Tan, Jane", 'She said "hello"\nand left'],
    ]);
  });

  it("keeps a CRLF inside quotes and ends rows on CRLF, LF or CR", () => {
    expect(parseCsv('a,b\r\n"x\r\ny",2\r\n')).toEqual([
      ["a", "b"],
      ["x\r\ny", "2"],
    ]);
    expect(parseCsv("a,b\r1,2\r3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("drops a UTF-8 byte order mark and needs no trailing newline", () => {
    expect(parseCsv("﻿Name,Email\nJane,j@x.com")).toEqual([
      ["Name", "Email"],
      ["Jane", "j@x.com"],
    ]);
  });

  it("a trailing newline adds no empty row, and empty lines are skipped", () => {
    expect(parseCsv("a,b\n\n1,2\n\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps ragged rows as they are and empty cells as empty text", () => {
    expect(parseCsv("a,b,c\n1\n1,,3,4\n")).toEqual([["a", "b", "c"], ["1"], ["1", "", "3", "4"]]);
  });

  it("reads a semicolon-separated file", () => {
    expect(parseCsv('First Name;Last Name;Company\nJane;Tan;"Acme; Inc"\n')).toEqual([
      ["First Name", "Last Name", "Company"],
      ["Jane", "Tan", "Acme; Inc"],
    ]);
  });

  it("reads a tab-separated file", () => {
    expect(parseCsv("Name\tEmail\nJane Tan, CFA\tj@x.com\n")).toEqual([
      ["Name", "Email"],
      ["Jane Tan, CFA", "j@x.com"],
    ]);
  });

  it("picks the separator from the header line, not from the notes above it", () => {
    const text = 'Notes:\n"A note; with; semicolons; in it"\n\nFirst Name,Last Name,Email Address\nJane,Tan,j@x.com\n';
    const rows = parseCsv(text);
    expect(rows[2]).toEqual(["First Name", "Last Name", "Email Address"]);
    expect(rows[3]).toEqual(["Jane", "Tan", "j@x.com"]);
  });

  it("a quote in the middle of an unquoted field is plain text", () => {
    expect(parseCsv('a,b\n5" disk,x\n')).toEqual([
      ["a", "b"],
      ['5" disk', "x"],
    ]);
  });

  it("an unclosed quote takes the rest of the file as one field and does not throw", () => {
    expect(parseCsv('a,b\n"open,1\n2,3')).toEqual([
      ["a", "b"],
      ["open,1\n2,3"],
    ]);
  });

  it("reads nothing from nothing", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("﻿")).toEqual([]);
  });

  it("text that looks like a formula or a script stays text", () => {
    expect(parseCsv('Name,Notes\n=HYPERLINK("http://x"),<script>alert(1)</script>\n')[1]).toEqual([
      '=HYPERLINK("http://x")',
      "<script>alert(1)</script>",
    ]);
  });
});

describe("findHeaderRow", () => {
  it("is the first row for an ordinary export", () => {
    expect(findHeaderRow([["First Name", "Last Name"], ["Jane", "Tan"]])).toBe(0);
  });

  it("skips the notes LinkedIn puts above its header", () => {
    const rows = parseCsv(
      'Notes:\n"When exporting your connection data, you may notice that some of the email addresses are missing."\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nJane,Tan,https://linkedin.com/in/jane,,Acme,Partner,12 Mar 2021\n',
    );
    expect(findHeaderRow(rows)).toBe(2);
  });

  it("prefers a recognised header over an earlier line with two cells", () => {
    expect(findHeaderRow([["Exported", "2026-11-01"], ["Name", "Email"], ["Jane", "j@x.com"]])).toBe(1);
  });

  it("with unfamiliar headings, is the first row with at least two filled cells", () => {
    expect(findHeaderRow([["My contacts"], ["", ""], ["Person", "Firm"], ["Jane", "Acme"]])).toBe(2);
  });

  it("only looks for a recognised header in the first 10 rows", () => {
    const rows: string[][] = [];
    for (let i = 0; i < 10; i++) rows.push([`a${i}`, `b${i}`]);
    rows.push(["First Name", "Last Name"]);
    expect(findHeaderRow(rows)).toBe(0);
  });

  it("falls back to the first row with anything in it, and to -1 for an empty file", () => {
    expect(findHeaderRow([[""], ["Names"], ["Jane"]])).toBe(1);
    expect(findHeaderRow([])).toBe(-1);
    expect(findHeaderRow([["", " "]])).toBe(-1);
  });
});

describe("toTable", () => {
  it("splits the header from the data rows and drops rows with nothing in them", () => {
    const table = toTable([["Notes:"], ["First Name", "Last Name"], ["Jane", "Tan"], ["", " "], ["Raj", "Rao"]]);
    expect(table.headers).toEqual(["First Name", "Last Name"]);
    expect(table.rows).toEqual([
      ["Jane", "Tan"],
      ["Raj", "Rao"],
    ]);
  });

  it("refuses a file with no rows under the header", () => {
    expect(() => toTable([["Name", "Email"]])).toThrow(ImportFileError);
    expect(() => toTable([["Name", "Email"]])).toThrow("This file has no contacts in it.");
    expect(() => toTable([])).toThrow("This file has no contacts in it.");
  });

  it("takes exactly 5,000 rows and refuses 5,001", () => {
    const rows: string[][] = [["Name", "Email"]];
    for (let i = 0; i < MAX_ROWS; i++) rows.push([`Person ${i}`, ""]);
    expect(toTable(rows).rows).toHaveLength(5000);
    rows.push(["One more", ""]);
    expect(() => toTable(rows)).toThrow("This file has more than 5,000 rows.");
  });

  it("refuses more than 200 columns", () => {
    const header = Array.from({ length: 201 }, (_, i) => `c${i}`);
    expect(() => toTable([header, header])).toThrow("This file has more than 200 columns.");
  });
});

describe("checkSize", () => {
  it("lets 10 MB through and refuses more", () => {
    expect(() => checkSize(MAX_BYTES)).not.toThrow();
    expect(() => checkSize(MAX_BYTES + 1)).toThrow("This file is larger than 10 MB.");
    expect(() => checkSize(0)).toThrow("This file is empty.");
  });
});

describe("sourceName", () => {
  it("names the standard exports from their headings", () => {
    expect(sourceName(["First Name", "Last Name", "URL", "Email Address", "Company", "Position", "Connected On"], "Connections.csv")).toBe("LinkedIn");
    expect(sourceName(["First Name", "Last Name", "Account Name", "Title", "Mailing Country", "Email"], "report.csv")).toBe("Salesforce");
    expect(sourceName(["Record ID", "First Name", "Last Name", "Email", "Associated Company", "Lifecycle Stage"], "all.csv")).toBe("HubSpot");
    expect(sourceName(["Name", "Given Name", "Family Name", "E-mail 1 - Value", "Organization 1 - Name"], "contacts.csv")).toBe("Google");
    expect(sourceName(["First Name", "Last Name", "Company", "Job Title", "E-mail Address", "Business Phone"], "contacts.csv")).toBe("Outlook");
  });

  it("is the file name without its extension otherwise, on one line and not too long", () => {
    expect(sourceName(["Person", "Firm"], "old crm people.xlsx")).toBe("old crm people");
    expect(sourceName(["Person", "Firm"], ".csv")).toBe("File");
    expect(sourceName(["Person", "Firm"], `${"x".repeat(200)}.csv`)).toHaveLength(60);
  });
});
