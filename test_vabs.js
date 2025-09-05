// Quick test to understand VABS behavior
const input = [-1, -100, 0x7FFF, -0x8000, -0x4000];
const expected = [1, 100, 0x7FFF, 0x8000, 0x4000];

for (let i = 0; i < input.length; i++) {
  const val = input[i];
  const absVal = val === -32768 ? 32767 : Math.abs(val);
  console.log(`abs(${val}) = ${absVal}, expected: ${expected[i]}`);
}
