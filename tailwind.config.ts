import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "rgb(var(--theme-background) / <alpha-value>)",
        foreground: "rgb(var(--theme-foreground) / <alpha-value>)",
        muted: "rgb(var(--theme-muted) / <alpha-value>)",
        accent: "rgb(var(--theme-accent) / <alpha-value>)",
        accentSoft: "rgb(var(--theme-accent-soft) / <alpha-value>)",
        onAccent: "rgb(var(--theme-on-accent) / <alpha-value>)",
        border: "rgb(var(--theme-border) / <alpha-value>)",
        danger: "rgb(var(--theme-danger) / <alpha-value>)",
        success: "rgb(var(--theme-success) / <alpha-value>)",
        warning: "rgb(var(--theme-warning) / <alpha-value>)"
      },
      boxShadow: {
        elevated: "0 18px 45px rgba(15,23,42,0.75)"
      },
      borderRadius: {
        xl: "1rem"
      }
    }
  },
  plugins: []
};

export default config;
