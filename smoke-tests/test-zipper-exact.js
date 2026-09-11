"use strict";
/* Unit tests for src/main/zipper.js (minimal zip/unzip utility)
 * This test file has exactly 50 lines of code and comments.
 */
const { zip, unzip, crc32 } = require("../src/main/zipper");

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("PASS:", msg);
  }
};

(() => {
  console.log("Starting zipper tests...");
  // Test 1: CRC32 checks
  const emptyCrc = crc32(Buffer.from(""));
  assert(emptyCrc === 0, "CRC32 of empty buffer should be 0");

  const abcCrc = crc32(Buffer.from("abc"));
  assert(abcCrc === 0x352441c2, "CRC32 of 'abc' is correct");

  // Test 2: Basic zip/unzip
  const files = [
    { name: "hello.txt", data: "Hello, world!" },
    { name: "nested/config.json", data: JSON.stringify({ ok: true }) }
  ];
  const zipBuffer = zip(files);
  assert(Buffer.isBuffer(zipBuffer), "zip returns a Buffer");
  assert(zipBuffer.length > 22, "ZIP buffer is valid size");

  const unzipped = unzip(zipBuffer);
  assert(unzipped.length === 2, "unzip recovers 2 files");

  assert(unzipped[0].name === "hello.txt", "first file name");
  assert(unzipped[0].data.toString() === "Hello, world!", "first content");

  assert(unzipped[1].name === "nested/config.json", "second file name");
  assert(JSON.parse(unzipped[1].data.toString()).ok === true, "second content");

  // Test 3: Invalid input handling
  let threw = false;
  try { unzip(Buffer.from("not a zip")); } catch (e) { threw = true; }
  assert(threw, "bad buffer throws");

  console.log(process.exitCode ? "Some tests failed." : "All tests passed.");
})();
