import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.base],
    rules: {
      "no-unused-vars": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/"],
  },
);
