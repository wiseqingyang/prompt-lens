import { zhCN, type LocaleSchema } from './zh-CN';
import { enUS } from './en-US';

export type SupportedLocale = 'zh-CN' | 'en-US';
export type LocaleMode = 'auto' | SupportedLocale;

export const messages: Record<SupportedLocale, LocaleSchema> = {
  'zh-CN': zhCN,
  'en-US': enUS
};

export { zhCN, enUS, type LocaleSchema };
