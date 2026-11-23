// Every static text of the authorization pages (docs/zh-CN/spec/05-surfaces.md §15 «远程授权»), here
// and nowhere else, in English and in Chinese: a page is in Chinese when the browser's first
// language starts with `zh`, in English otherwise. No text holds a token; what a client says of
// itself, a user's name and a connection's name are passed in and escaped where the page is made.
//
// Words: to a person, "connection instance" (as the CLI says), and "saveslot".

import type { pageLanguage, Scope } from "@fluxvita/saveslot-service";

export type Lang = ReturnType<typeof pageLanguage>;

/** The page's language, as the identity provider's pages choose it. */
export { pageLanguage as langOf } from "@fluxvita/saveslot-service";

export interface OAuthTexts {
  readonly htmlLang: string;
  readonly title: string;
  readonly signedInAs: (name: string) => string;
  readonly switchAccount: string;
  /** `client` and `host` are escaped by the caller. */
  readonly asksAccess: (client: string, host: string) => string;
  readonly redirectsTo: (host: string) => string;
  readonly cliAsks: string;
  readonly nameLabel: string;
  readonly nameHint: string;
  readonly scopesLabel: string;
  readonly scope: Readonly<Record<Scope, string>>;
  readonly readRequired: string;
  readonly allSlots: string;
  readonly allow: string;
  readonly allowCli: string;
  readonly deny: string;
  readonly errorTitle: string;
  readonly errors: {
    readonly client: string;
    readonly redirect: string;
    readonly tooLong: string;
    readonly form: string;
    readonly user: string;
    readonly tenant: string;
    readonly name: string;
    readonly nameTaken: string;
    readonly scopes: string;
    readonly internal: string;
  };
}

const EN: OAuthTexts = {
  htmlLang: "en",
  title: "Authorize access to saveslot",
  signedInAs: (name) => `Signed in as ${name}.`,
  switchAccount: "Not you? Sign in with another account.",
  asksAccess: (client, host) => `${client} (${host}) asks for access to your saveslot.`,
  redirectsTo: (host) => `After you answer, you will be sent back to ${host}.`,
  cliAsks: "The saveslot command line asks to sign in as you.",
  nameLabel: "Name of this connection instance",
  nameHint: "It appears in the history, in pending items and in the read audit.",
  scopesLabel: "What it may do",
  scope: {
    "saveslot.read": "Read your records (always needed)",
    "saveslot.write": "Write records",
    "saveslot.schema": "Create slots and change their structure",
    "saveslot.delete": "Delete records",
  },
  readRequired: "Reading is always granted: writing needs it.",
  allSlots: "It will see every slot, including slots created later.",
  allow: "Authorize",
  allowCli: "Sign in",
  deny: "Deny",
  errorTitle: "This authorization request cannot be used",
  errors: {
    client:
      "The application could not be identified: its client ID is not a client document saveslot can use.",
    redirect:
      "The application asked to be sent back to an address it did not register. Nothing was sent to it.",
    tooLong: "The authorization request is too long.",
    form: "This form has expired or was already sent. Go back to the application and start again.",
    user: "This account cannot authorize access.",
    tenant: "This account has no saveslot data yet.",
    name: "Give the connection instance a name of 1 to 100 characters, without line breaks.",
    nameTaken: "Another connection instance has this name. Choose another.",
    scopes: "The permissions sent are not ones this request offered.",
    internal: "Something went wrong on saveslot's side. Try again later.",
  },
};

const ZH: OAuthTexts = {
  htmlLang: "zh-CN",
  title: "授权访问 saveslot",
  signedInAs: (name) => `当前登录：${name}。`,
  switchAccount: "不是你？换一个账户登录。",
  asksAccess: (client, host) => `${client}（${host}）请求访问你的 saveslot。`,
  redirectsTo: (host) => `你作出选择后，页面会回到 ${host}。`,
  cliAsks: "saveslot 命令行请求以你的身份登录。",
  nameLabel: "这个连接实例的名字",
  nameHint: "它会出现在历史、待处理事项与读取审计里。",
  scopesLabel: "它能做什么",
  scope: {
    "saveslot.read": "读取你的记录（必需）",
    "saveslot.write": "写入记录",
    "saveslot.schema": "新建 slot、修改结构",
    "saveslot.delete": "删除记录",
  },
  readRequired: "读取总是授予的：写入要先读。",
  allSlots: "它能看到全部 slot，包括以后新建的。",
  allow: "授权",
  allowCli: "登录",
  deny: "拒绝",
  errorTitle: "这个授权请求不能使用",
  errors: {
    client: "无法识别这个应用：它的客户端 ID 不是 saveslot 能用的客户端文档。",
    redirect: "这个应用要求回到一个它没有登记的地址。没有向它发送任何东西。",
    tooLong: "授权请求太长。",
    form: "这个表单已过期或已经提交过。请回到应用里重新开始。",
    user: "这个账户不能授权访问。",
    tenant: "这个账户还没有 saveslot 数据。",
    name: "给连接实例起一个 1 到 100 个字符的名字，不要换行。",
    nameTaken: "已有一个连接实例叫这个名字，请换一个。",
    scopes: "提交的权限不在这次请求提供的范围内。",
    internal: "saveslot 这一侧出了问题，请稍后再试。",
  },
};

/** The texts of the pages in `lang`. */
export function oauthTexts(lang: Lang): OAuthTexts {
  return lang === "zh" ? ZH : EN;
}
