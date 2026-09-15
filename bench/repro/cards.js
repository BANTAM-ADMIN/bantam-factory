// Fixed benchmark cards. Each card has a deterministic, verifiable answer.
// These are the smallest possible "fight cards": same input every run,
// known-correct output, so any solver can be compared against them.

export const cards = [
  {
    id: 'c01',
    name: 'sum-range',
    prompt: 'Sum the integers from 1 to 100.',
    answer: '5050',
    check: (out) => out.trim() === '5050',
  },
  {
    id: 'c02',
    name: 'fib-10',
    prompt: 'What is the 10th Fibonacci number (F(1)=1, F(2)=1)?',
    answer: '55',
    check: (out) => out.trim() === '55',
  },
  {
    id: 'c03',
    name: 'prime-check',
    prompt: 'Is 97 a prime number? Answer yes or no.',
    answer: 'yes',
    check: (out) => out.trim().toLowerCase() === 'yes',
  },
  {
    id: 'c04',
    name: 'reverse-word',
    prompt: 'Reverse the word "bantam" and give only the reversed word.',
    answer: 'man tab',
    check: (out) => out.trim().toLowerCase() === 'man tab',
  },
  {
    id: 'c05',
    name: 'count-vowels',
    prompt: 'How many vowels are in the word "reproducibility"? Give only the number.',
    answer: '8',
    check: (out) => out.trim() === '8',
  },
];
