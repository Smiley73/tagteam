// Sits beside workflows/ship.js so that a Claude Code workflow script has a
// module to import. The script does not try: the runtime rejects import().
export const sibling = "sibling module loaded";
