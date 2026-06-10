// Tailwind config moved out of the SPA's runtime (no more CDN). The JIT
// scans src/**/*.{html,js} for class names; the SPA only ever uses static
// class strings so no `safelist` should be needed.
module.exports = {
  content: ['./src/**/*.{html,js}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Inter"',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
    },
  },
  plugins: [require('@tailwindcss/forms')],
};
