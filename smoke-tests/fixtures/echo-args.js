// Fake reviewer CLI: prints back the value passed after -p (the OLD mangled path).
const a = process.argv.slice(2);
const i = a.indexOf("-p");
process.stdout.write(i >= 0 && a[i + 1] != null ? a[i + 1] : "(no -p arg)");
