/** 与核心 validateModelInput 保持一致的凭据引用格式。 */
export const CREDENTIAL_REF_PATTERN = /^(env:[A-Za-z_][A-Za-z0-9_]*|keychain:[^:\s]+(?::[^:\s]+)?)$/;

export function isCredentialRef(value: string): boolean {
  return CREDENTIAL_REF_PATTERN.test(value.trim());
}
