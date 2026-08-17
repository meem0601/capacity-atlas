import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MESSAGES, SUPPORTED_LOCALES, translate } from "../public/i18n.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const VIEWS = ["../public/client.js", "../public/connector-client.js", "../public/setup-model.js"];

/** テンプレートが要求する差し込み名。{count} と ICU の {count, plural, ...} の両方を拾う。 */
function placeholderNames(template) {
  const names = new Set();
  for (const [, name] of template.matchAll(/\{(\w+)(?:,\s*plural,)?[^{}]*\}/g)) names.add(name);
  for (const [, name] of template.matchAll(/\{(\w+)\}/g)) names.add(name);
  return [...names];
}

function keysWithPlaceholders(locale) {
  return Object.entries(MESSAGES[locale])
    .filter(([, value]) => placeholderNames(value).length > 0)
    .map(([key]) => key);
}

test("every locale defines the same keys", () => {
  const [first, ...rest] = SUPPORTED_LOCALES;
  for (const locale of rest) {
    assert.deepEqual(
      Object.keys(MESSAGES[locale]).sort(),
      Object.keys(MESSAGES[first]).sort(),
      `${locale} does not define the same keys as ${first}`
    );
  }
});

// 実際に起きた不具合: カードのボタンが t("disconnect.mergeAction") を引数なしで呼び、
// 画面に "{count}件の重複を整理" とそのまま表示されていた。
// translate() は値が無い差し込みを {name} のまま返すため、呼び忘れは黙って画面へ出る。
test("callers never use a placeholder message without substitutions", () => {
  const offenders = [];
  for (const path of VIEWS) {
    const source = read(path);
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of keysWithPlaceholders(locale)) {
        // t("key") / translate("key") の直後が閉じ括弧＝差し込み値を渡していない
        const pattern = new RegExp(`\\b(?:t|translate)\\(\\s*["'\`]${key.replace(/\./g, "\\.")}["'\`]\\s*\\)`);
        if (pattern.test(source)) offenders.push(`${path}: ${key}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `these call sites would render a raw placeholder:\n${offenders.join("\n")}`);
});

// applyTranslations は data-i18n 属性を translate(key, {}) で描くので、
// 差し込みが必要なキーを属性で使うと必ず素通りする。
test("markup never wires a placeholder message to data-i18n", () => {
  const html = read("../public/index.html");
  const attributeKeys = [...html.matchAll(/data-i18n(?:-aria|-title)?="([^"]+)"/g)].map(match => match[1]);
  const needsValues = new Set(SUPPORTED_LOCALES.flatMap(locale => keysWithPlaceholders(locale)));
  const offenders = attributeKeys.filter(key => needsValues.has(key));

  assert.deepEqual(offenders, [], `these keys need substitutions and cannot be used as attributes:\n${offenders.join("\n")}`);
});

test("translate leaves no placeholder behind when given its values", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const [key, template] of Object.entries(MESSAGES[locale])) {
      const params = Object.fromEntries(placeholderNames(template).map(name => [name, 2]));
      const rendered = translate(key, params, locale);
      assert.ok(
        !/\{\w+\}/.test(rendered),
        `${locale}/${key} still contains a placeholder after substitution: ${rendered}`
      );
    }
  }
});
