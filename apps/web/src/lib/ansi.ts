/** 登录进程输出可能带终端控制序列；网页按纯文本显示前去掉。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 这里就是要匹配控制字符
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '').replace(/\r\n?/g, '\n');
