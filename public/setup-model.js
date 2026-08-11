const GUIDES = {
  ja: {
    codex: {
      title: "GPT / Codex",
      capability: "複数アカウント対応",
      actionLabel: "OpenAIログインを始める",
      steps: [
        "下のボタンを押すと、OpenAIの公式ログイン画面が開きます。",
        "Capacity Atlasで使いたいアカウントを選んでログインします。",
        "ログイン後は自動で接続されます。コードの入力は必要ありません。"
      ],
      note: "パスワード・OAuthトークンはWeb画面やVercelへ送信されず、このPC内だけに保存されます。"
    },
    claude: {
      title: "Claude",
      capability: "ブラウザOAuth接続",
      actionLabel: "Claudeへ接続",
      steps: [
        "初回だけ、Capacity Atlas ConnectorがClaudeの公式認証機能を自動で準備します。事前インストールは不要です。",
        "Anthropicの公式ログイン画面で、Capacity Atlasに追加するFree・Pro・Max等のClaudeアカウントを選びます。",
        "ログイン後は自動で接続されます。コードの入力は必要ありません。"
      ],
      note: "非公式連携です。パスワード・OAuthトークン・利用枠はこのPC内だけで扱い、Vercelへ送信しません。"
    },
    grok: {
      title: "Grok",
      capability: "現在のアカウントを接続",
      actionLabel: "Grokを再接続",
      steps: [
        "Capacity Atlas Connectorが、Grokの公式ログイン画面を開きます。",
        "Capacity Atlasで使いたいxAIアカウントを選んでログインします。",
        "ログイン後は自動で接続されます。コードの入力は必要ありません。"
      ],
      note: "現行Grok CLIでは正式な認証ホーム分離を確認できないため、初版の複数アカウント分離は未対応です。"
    }
  },
  en: {
    codex: {
      title: "GPT / Codex",
      capability: "Multiple accounts supported",
      actionLabel: "Sign in with OpenAI",
      steps: [
        "Select the button below to open the official OpenAI sign-in page.",
        "Choose the account you want to use with Capacity Atlas and sign in.",
        "Capacity Atlas connects automatically after sign-in. No code entry is required."
      ],
      note: "Passwords and OAuth tokens never reach the web app or Vercel. They stay on this computer."
    },
    claude: {
      title: "Claude",
      capability: "Browser OAuth connection",
      actionLabel: "Connect Claude",
      steps: [
        "On first use, Capacity Atlas Connector prepares Claude authentication automatically. No prior install is required.",
        "On the official Anthropic sign-in page, choose the Free, Pro, Max, or other Claude account to add.",
        "Capacity Atlas connects automatically after sign-in. No code entry is required."
      ],
      note: "This is an unofficial integration. Passwords, OAuth tokens, and capacity data stay on this computer and are never sent to Vercel."
    },
    grok: {
      title: "Grok",
      capability: "Connect the current account",
      actionLabel: "Reconnect Grok",
      steps: [
        "Capacity Atlas Connector opens the official Grok sign-in page.",
        "Choose the xAI account you want to use with Capacity Atlas and sign in.",
        "Capacity Atlas connects automatically after sign-in. No code entry is required."
      ],
      note: "The current Grok CLI does not expose supported authentication-home isolation, so multiple isolated accounts are not available yet."
    }
  }
};

export function setupGuide(provider, locale = "ja") {
  return (GUIDES[locale] || GUIDES.ja)[provider] ?? null;
}

export function loginOpenedLabel(provider, locale = "ja") {
  const serviceName = { codex: "OpenAI", claude: "Claude", grok: "Grok" }[provider] || (locale === "en" ? "AI service" : "AIサービス");
  return locale === "en" ? `Opened the ${serviceName} sign-in page` : `${serviceName}のログイン画面を開きました`;
}
