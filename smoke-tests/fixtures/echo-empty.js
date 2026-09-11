// Fake CLI that prints nothing (simulates agy non-TTY stdout drop).
process.stdin.resume(); process.stdin.on("data", () => {}); process.stdin.on("end", () => process.exit(0));
