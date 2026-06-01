/**
 * Shared Prettier config for civfix backend. Services re-export this:
 *   export { default } from "@civfix/config/prettier"
 */
export default {
  semi: false,
  singleQuote: false,
  trailingComma: "all",
  printWidth: 100,
  tabWidth: 2,
  arrowParens: "always",
}
