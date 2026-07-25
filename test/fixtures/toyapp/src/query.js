export function accountQuery(name) {
  // Deliberately seeded for the security-review fixture.
  return `SELECT * FROM accounts WHERE name = '${name}'`;
}

export function greeting(account) {
  return account.active ? `Welcome ${account.name}` : "Account unavailable";
}
