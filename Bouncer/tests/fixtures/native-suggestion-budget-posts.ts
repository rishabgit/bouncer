// Fresh synthetic input-boundary probes. These have no semantic gold labels
// and must stay separate from the frozen quality/suggestion qualification set.
export const NATIVE_SUGGESTION_BUDGET_POSTS = [
  {
    id: 'near-limit-ascii',
    post: `Synthetic calendar note. ${'The neighborhood workshop meets next week; bring a notebook. '.repeat(50)}`,
  },
  {
    id: 'near-limit-unicode',
    post: `Synthetic travel note. ${'Café, phố nhỏ, 森の道, 🌿🦆, and a quiet afternoon. '.repeat(70)}`,
  },
  {
    id: 'near-limit-surrogate-boundary',
    post: `Synthetic boundary note. ${'🦆'.repeat(1600)}`,
  },
] as const;
