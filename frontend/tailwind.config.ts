import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: "#EA1D2C", dark: "#C4121F" },
        pago: "#A5124F",
        ink: "#3E3E3E",
        muted: "#717171",
        soft: "#F6F6F6",
        line: "#E6E6E6",
        pix: "#32BCAD",
        saving: "#0F7B3E",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
      keyframes: {
        sheetUp: { from: { transform: "translateY(100%)" }, to: { transform: "translateY(0)" } },
        fadeIn: { from: { opacity: "0" }, to: { opacity: "1" } },
      },
      animation: {
        sheetUp: "sheetUp .28s cubic-bezier(.2,.8,.2,1)",
        fadeIn: "fadeIn .2s ease-out",
      },
    },
  },
  plugins: [],
};
export default config;
