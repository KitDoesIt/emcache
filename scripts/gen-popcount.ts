const popcount = (n: number) => {
  let count = 0;
  for (let i = 0; i < 8; i++) {
    count += (n >> i) & 1;
  }
  return count;
};

const entries: number[] = [];
for (let i = 0; i < 256; i++) {
  entries.push(popcount(i));
}

const lines: string[] = [];
for (let row = 0; row < 16; row++) {
  const line = entries.slice(row * 16, row * 16 + 16).join(",");
  lines.push("    " + line);
}

console.log("const POPCOUNT = new Uint8Array([");
console.log(lines.join(",\n"));
console.log("  ]);");
