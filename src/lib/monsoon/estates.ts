export type EstateKey = "traxo" | "zeroone";

export const ESTATES: readonly {
  key: EstateKey;
  label: string;
  dbEnv: string;
  defaultRole: string;
}[] = [
  { key: "traxo", label: "Traxo", dbEnv: "TRAXO_CRM_DATABASE_URL", defaultRole: "lp_prospect" },
  { key: "zeroone", label: "Zero One", dbEnv: "ZEROONE_CRM_DATABASE_URL", defaultRole: "investor" },
];

export function estateByKey(key: unknown): (typeof ESTATES)[number] | undefined {
  return ESTATES.find((estate) => estate.key === key);
}
