// Fake reviewer CLI: prints back exactly what it received on stdin.
let d = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { d += c; });
process.stdin.on("end", () => { process.stdout.write(d); });
