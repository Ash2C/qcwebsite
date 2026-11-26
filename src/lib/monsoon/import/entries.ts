// The timeline entries a bulk import writes, in one place: save.ts writes them with these, and the
// Recent order (sift.ts, contacts.ts) leaves them out with `IMPORT_ENTRY_SQL`. They are `system`
// entries like a priority or details change, so they are told apart by how their text begins.
// No database and no Node-only imports here.

const IMPORTED_FROM = "Imported from ";
const ALSO_IN = "Also in ";
const PEOPLE_IMPORTED_FROM = " imported from ";

/** On a new person's own pipeline entry. */
export const importedFromEntry = (label: string): string => `${IMPORTED_FROM}${label}.`;

/** On the pipeline entry of someone already on file. */
export const alsoInEntry = (label: string): string => `${ALSO_IN}${label}.`;

/** On a company that is itself the pipeline entry, for the people filed under it. */
export const companyImportEntry = (n: number, label: string): string =>
  `${n} ${n === 1 ? "person" : "people"}${PEOPLE_IMPORTED_FROM}${label}.`;

/** SQL, fixed text: true for a `touches` row (alias `t`) that an import wrote. */
export const IMPORT_ENTRY_SQL = `(t.kind = 'system' AND (left(t.summary, ${IMPORTED_FROM.length}) = '${IMPORTED_FROM}'
           OR left(t.summary, ${ALSO_IN.length}) = '${ALSO_IN}'
           OR t.summary ~ '^[0-9]+ (person|people)${PEOPLE_IMPORTED_FROM}'))`;

/**
 * SQL, fixed text: when a pipeline member (alias `m`) was last touched or updated, for the Recent
 * order. An import's own entries do not count: importing a file moves nobody up the list.
 */
export const RECENT_AT_SQL = `GREATEST(m.updated_at, (SELECT max(t.at) FROM touches t WHERE t.member_id = m.id AND NOT ${IMPORT_ENTRY_SQL}))`;
