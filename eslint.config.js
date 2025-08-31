import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettier from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";
import solidPlugin from "eslint-plugin-solid";
import globals from "globals";

const baseConfig = {
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 2020,
    sourceType: "module",
  },
  plugins: {
    "@typescript-eslint": tseslint,
    prettier: prettier,
  },
  rules: {
    ...tseslint.configs.recommended.rules,
    ...prettierConfig.rules,
    "prettier/prettier": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      },
    ],
    "@typescript-eslint/explicit-function-return-type": "off",
    "@typescript-eslint/no-explicit-any": "error",
    "no-undef": "off",
    "no-empty": ["error", { allowEmptyCatch: true }],
  },
};

export default [
  js.configs.recommended,

  // TypeScript files
  {
    files: ["src/**/*.ts"],
    ...baseConfig,
    languageOptions: {
      ...baseConfig.languageOptions,
      globals: {
        ...globals.browser,
        ...globals.node,
        vi: "readonly",
      },
    },
  },

  // TypeScript + JSX files
  {
    files: ["src/**/*.tsx"],
    ...baseConfig,
    languageOptions: {
      ...baseConfig.languageOptions,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        vi: "readonly",
      },
    },
    plugins: {
      ...baseConfig.plugins,
      solid: solidPlugin,
    },
    rules: {
      ...baseConfig.rules,
      ...solidPlugin.configs.recommended.rules,
    },
  },

  // Test files
  {
    files: ["src/**/*.test.{ts,tsx}", "src/test-setup.ts"],
    ...baseConfig,
    languageOptions: {
      ...baseConfig.languageOptions,
      globals: {
        ...globals.browser,
        ...globals.node,
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        beforeAll: "readonly",
        beforeEach: "readonly",
        afterAll: "readonly",
        afterEach: "readonly",
        vi: "readonly",
        global: "writable",
      },
    },
    rules: {
      ...baseConfig.rules,
      "@typescript-eslint/no-explicit-any": "off", // Allow any in tests
    },
  },

  // Build/config files
  {
    files: ["config/**/*.ts", "build-component.js"],
    ...baseConfig,
    languageOptions: {
      ...baseConfig.languageOptions,
      globals: globals.node,
    },
  },
];
