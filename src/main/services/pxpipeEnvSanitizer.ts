/**
 * Claude Code が system prompt や messages (role: system) に埋め込む `# Environment` 節を、
 * pxpipe プロキシへ転送する前段で外科的にサニタイズする純関数群（13_pxp Phase 1 & 070 M4 台帳 #74 対応）。
 *
 * 設計制約（三毛レビュー ガードレール①②。詳細は
 * `_Prompt/13_pxp/20260724_0544_13_pxp_model-switch-injection-fix.md` 参照）:
 * - identity 行は「人間可読名の再構築」をしない。ID とリクエストの `model` フィールドを
 *   機械的に突き合わせるだけで、名前⇔ID⇔コンテキスト窓表記を捏造で一致させることはしない
 *   （固定モデル名カタログを内部に持つと、除去対象そのものを再発明することになるため）。
 *   不一致検知時は行を除去するのみ（ガードレール①）。
 * - `# Environment` 区間の外側は生バイトを一切変更しない（JSON 全体の parse→stringify
 *   ラウンドトリップをしない）。JSON.parse は区間の特定・妥当性検証にのみ使い、書き戻しは
 *   元の生テキストへの文字列 slice+concat で行う（ガードレール②）。
 */

const ENV_SECTION_PATTERN = /(?:^|\n)(# Environment(?:\s+update)?\b[\s\S]*?)(?=\n#{1,6}\s|$)/g

/**
 * Codex adversarial-review round4 指摘（severity: high）: 見出しテキストの一致だけで
 * `# Environment` 節を同定すると、ユーザー/プロジェクトの CLAUDE.md 等（system の先行
 * ブロックに載る）が同名の見出し（例: "# Environment Setup"）を持つだけで decoy に一致し、
 * 後続にある本物の CC 生成ブロックへ到達しないまま終了してしまう（先勝ち・早期 break の
 * 直接帰結）。対策として、見出し一致に加え、CC が実際に生成するブロックに含まれる既知の
 * フィールドラベルを一定数以上含むことを「本物」の追加条件にする。固定モデル名カタログの
 * ような陳腐化ベクタにはならない（ID/名前を持たず、事実ラベルの語彙のみ）。
 */
const KNOWN_ENV_FIELD_MARKERS = [
  'Primary working directory:',
  'Is a git repository:',
  'Platform:',
  'OS Version:',
  'You are powered by the model'
]
const MIN_ENV_FIELD_MARKERS = 2

function countKnownEnvFieldMarkers(text: string): number {
  let n = 0
  for (const marker of KNOWN_ENV_FIELD_MARKERS) {
    if (text.includes(marker)) n++
  }
  return n
}

/** `text` 内の `# Environment` 見出し候補を先頭から順に走査し、既知フィールドラベルを
 *  一定数以上含む「本物」の最初の1件を返す（decoy をスキップして次候補へ進む）。 */
function findGenuineEnvSection(text: string): string | null {
  const pattern = new RegExp(ENV_SECTION_PATTERN.source, ENV_SECTION_PATTERN.flags)
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    if (countKnownEnvFieldMarkers(m[1]) >= MIN_ENV_FIELD_MARKERS) {
      return m[1]
    }
    if (m.index === pattern.lastIndex) pattern.lastIndex++ // 0幅マッチの無限ループ防止
  }
  return null
}

/** `system` 内のカタログ節（マーカーが足りなくても陳腐化カタログ行を含むもの）を検出する。 */
function findSystemCatalogSection(text: string): string | null {
  const pattern = new RegExp(ENV_SECTION_PATTERN.source, ENV_SECTION_PATTERN.flags)
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    if (
      STALE_CATALOG_LINE_PATTERN.test(m[1]) ||
      DIRECTIVE_DEFAULT_MODEL_LINE_PATTERN.test(m[1]) ||
      countKnownEnvFieldMarkers(m[1]) >= MIN_ENV_FIELD_MARKERS
    ) {
      return m[1]
    }
    if (m.index === pattern.lastIndex) pattern.lastIndex++
  }
  return null
}

/** 陳腐化した推奨モデルカタログ行（"most recent Claude models" 系）。行ごと除去する。 */
export const STALE_CATALOG_LINE_PATTERN = /^.*The most recent Claude models are.*$\n?/m

/**
 * モデル選定を誘導する指示文（"default to the latest" 系）。観測済みフォーマットでは
 * 陳腐化カタログ行と同一行に同居しているため通常は上記パターンで併せて除去されるが、
 * 将来的に別行へ分離された場合の保険として独立して除去する。
 */
export const DIRECTIVE_DEFAULT_MODEL_LINE_PATTERN =
  /^.*default to the latest and most capable Claude models.*$\n?/im

/** モデル同一性を主張する行（"You are powered by the model..."）。行ごと除去可能な単位で捕捉する。 */
export const IDENTITY_LINE_PATTERN = /^.*You are powered by the model.*$\n?/m

/** identity 行の中からモデル ID トークンを抜き出す（`claude-xxx` 形。variant サフィックスは別途除去）。 */
const MODEL_ID_TOKEN_PATTERN = /claude-[a-z0-9][a-z0-9-]*/i

/** `[1m]` 等の variant サフィックス。base モデル ID の比較前に正規化として取り除く。 */
const VARIANT_SUFFIX_PATTERN = /\[[^\]]*\]/g

function normalizeModelId(id: string): string {
  return id.replace(VARIANT_SUFFIX_PATTERN, '').trim().toLowerCase()
}

export type SkipReason =
  | 'no_environment_section_found'
  | 'unparseable_json'
  | 'system_field_anchor_not_unique_in_raw_body'
  | 'messages_field_anchor_not_unique_in_raw_body'
  | 'escaped_section_not_found_in_raw_body'
  | 'escaped_section_ambiguous_in_raw_body'

export interface SanitizeInfo {
  changed: boolean
  /** 除去した陳腐化行のパターン名一覧。 */
  strippedPatterns: Array<'staleCatalog' | 'directiveDefaultModel'>
  /** identity 行を除去したか（ID 不一致検知時のみ true）。 */
  identityRemoved: boolean
  /** identity 行が見つかり、ID が一致していたため無変更だったか。 */
  identityMatched: boolean
  /** サニタイズを見送った理由（fail-open 発火時のみ）。無変更でも strippedPatterns/identityRemoved
   *  が両方とも空 false であれば「対象が見つからなかった」ケースと「見つかったが変更不要だった」
   *  ケースを区別するためにこのフィールドを見る。 */
  skippedReason?: SkipReason
}

export interface SanitizeResult {
  body: Buffer
  info: SanitizeInfo
}

function extractTextCandidates(val: unknown): Array<{ text: string }> {
  if (typeof val === 'string') return [{ text: val }]
  if (Array.isArray(val)) {
    const out: Array<{ text: string }> = []
    for (const block of val) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        out.push({ text: (block as { text: string }).text })
      }
    }
    return out
  }
  return []
}

/** `# Environment` 節本文にサニタイズを適用し、変更後テキストと適用内訳を返す（純関数）。 */
function sanitizeSectionText(
  section: string,
  requestModel: string | null
): { text: string; info: Omit<SanitizeInfo, 'changed' | 'skippedReason'> } {
  let text = section
  const strippedPatterns: SanitizeInfo['strippedPatterns'] = []

  if (STALE_CATALOG_LINE_PATTERN.test(text)) {
    text = text.replace(STALE_CATALOG_LINE_PATTERN, '')
    strippedPatterns.push('staleCatalog')
  }
  if (DIRECTIVE_DEFAULT_MODEL_LINE_PATTERN.test(text)) {
    text = text.replace(DIRECTIVE_DEFAULT_MODEL_LINE_PATTERN, '')
    strippedPatterns.push('directiveDefaultModel')
  }

  let identityRemoved = false
  let identityMatched = false
  const identityMatch = IDENTITY_LINE_PATTERN.exec(text)
  if (identityMatch) {
    const idToken = MODEL_ID_TOKEN_PATTERN.exec(identityMatch[0])
    if (idToken && requestModel) {
      const lineId = normalizeModelId(idToken[0])
      const reqId = normalizeModelId(requestModel)
      if (lineId === reqId) {
        identityMatched = true
      } else {
        // ID 不一致: 名前を捏造して「補正」しない。矛盾する行を除去するのみ（ガードレール①）。
        text = text.replace(IDENTITY_LINE_PATTERN, '')
        identityRemoved = true
      }
    }
    // idToken が取れない、または requestModel が無い場合は判定材料不足のため無変更のまま
    // （fail-open。identityMatched/identityRemoved とも false のまま返す）。
  }

  return { text, info: { strippedPatterns, identityRemoved, identityMatched } }
}

/**
 * 生テキスト内のアンカー区間内において、エスケープ後文字列を外科的に安全置換するヘルパー関数。
 * 対象外のバイトは 1 バイトも変更しない（ガードレール②）。
 */
function replaceSliceInAnchor(
  bodyText: string,
  anchorSerialized: string,
  originalSection: string,
  sanitizedSection: string,
  anchorNotUniqueReason: SkipReason
): { success: true; newBodyText: string } | { success: false; reason: SkipReason } {
  const firstIdx = bodyText.indexOf(anchorSerialized)
  if (firstIdx === -1 || bodyText.indexOf(anchorSerialized, firstIdx + 1) !== -1) {
    return { success: false, reason: anchorNotUniqueReason }
  }

  const anchorSlice = bodyText.slice(firstIdx, firstIdx + anchorSerialized.length)
  const escapedOriginal = JSON.stringify(originalSection).slice(1, -1)
  const escapedSanitized = JSON.stringify(sanitizedSection).slice(1, -1)

  const idxWithinSlice = anchorSlice.indexOf(escapedOriginal)
  if (idxWithinSlice === -1) {
    return { success: false, reason: 'escaped_section_not_found_in_raw_body' }
  }
  if (anchorSlice.indexOf(escapedOriginal, idxWithinSlice + 1) !== -1) {
    return { success: false, reason: 'escaped_section_ambiguous_in_raw_body' }
  }

  const newAnchorSlice =
    anchorSlice.slice(0, idxWithinSlice) +
    escapedSanitized +
    anchorSlice.slice(idxWithinSlice + escapedOriginal.length)

  const newBodyText =
    bodyText.slice(0, firstIdx) +
    newAnchorSlice +
    bodyText.slice(firstIdx + anchorSerialized.length)

  return { success: true, newBodyText }
}

/**
 * Anthropic Messages API のリクエスト生バイトを受け取り、system および messages (role: system) 内の
 * `# Environment` 節をサニタイズして返す。区間外は完全にバイト同一（ガードレール②）。
 * 対象が見つからない・解析できない場合は無変更で返す（fail-open）。
 */
export function sanitizeEnvironmentBlock(rawBody: Buffer): SanitizeResult {
  let bodyText = rawBody.toString('utf8')

  let parsed: { system?: unknown; messages?: unknown; model?: unknown }
  try {
    parsed = JSON.parse(bodyText) as { system?: unknown; messages?: unknown; model?: unknown }
  } catch {
    return {
      body: rawBody,
      info: {
        changed: false,
        strippedPatterns: [],
        identityRemoved: false,
        identityMatched: false,
        skippedReason: 'unparseable_json'
      }
    }
  }

  const requestModel = typeof parsed.model === 'string' ? parsed.model : null
  const combinedStrippedPatterns: SanitizeInfo['strippedPatterns'] = []
  let combinedIdentityRemoved = false
  let combinedIdentityMatched = false
  let anySectionFound = false
  let changed = false

interface ElementSpan {
  start: number
  end: number
}

function findCloseQuote(str: string, startIdx: number): number {
  let escape = false
  for (let i = startIdx + 1; i < str.length; i++) {
    if (escape) {
      escape = false
      continue
    }
    if (str[i] === '\\') {
      escape = true
      continue
    }
    if (str[i] === '"') return i
  }
  return -1
}

/**
 * bodyText 内のトップレベル直下（深さ 1）の "messages" 配列と各メッセージ要素のスパンを構文走査で厳格特定する。
 * ネストした decoy.messages や別フィールド内のオブジェクトへの誤置換を 100% 構造的に排除する。
 */
function locateMessagesArrayAndElements(bodyText: string): {
  arrayStart: number
  arrayEnd: number
  elementSpans: ElementSpan[]
} | null {
  let depth = 0
  let inString = false
  let escapeNext = false
  let arrayStart = -1

  // 1. トップレベル（深さ 1）のキー "messages" を探索
  for (let i = 0; i < bodyText.length; i++) {
    const ch = bodyText[i]
    if (escapeNext) {
      escapeNext = false
      continue
    }
    if (ch === '\\' && inString) {
      escapeNext = true
      continue
    }
    if (ch === '"') {
      if (!inString && depth === 1) {
        const closeQuote = findCloseQuote(bodyText, i)
        if (closeQuote !== -1) {
          const key = bodyText.slice(i + 1, closeQuote)
          if (key === 'messages') {
            const afterKey = bodyText.slice(closeQuote + 1)
            const match = /^\s*:\s*\[/.exec(afterKey)
            if (match) {
              arrayStart = closeQuote + 1 + match.index + match[0].length - 1
              break
            }
          }
          i = closeQuote
          continue
        }
      }
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === '{' || ch === '[') {
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
    }
  }

  if (arrayStart === -1) return null

  // 2. トップレベル messages 配列内の各要素（オブジェクト）のスパンを特定
  let arrayDepth = 0
  let objDepth = 0
  inString = false
  escapeNext = false
  let arrayEnd = -1
  const elementSpans: ElementSpan[] = []
  let currentElemStart = -1

  for (let i = arrayStart; i < bodyText.length; i++) {
    const ch = bodyText[i]
    if (escapeNext) {
      escapeNext = false
      continue
    }
    if (ch === '\\' && inString) {
      escapeNext = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === '[') {
      arrayDepth++
    } else if (ch === ']') {
      arrayDepth--
      if (arrayDepth === 0) {
        arrayEnd = i + 1
        break
      }
    } else if (ch === '{') {
      if (arrayDepth === 1 && objDepth === 0) {
        currentElemStart = i
      }
      objDepth++
    } else if (ch === '}') {
      objDepth--
      if (arrayDepth === 1 && objDepth === 0 && currentElemStart !== -1) {
        elementSpans.push({ start: currentElemStart, end: i + 1 })
        currentElemStart = -1
      }
    }
  }

  if (arrayEnd === -1 || arrayDepth !== 0 || objDepth !== 0) return null
  return { arrayStart, arrayEnd, elementSpans }
}

  // 1. messages (role: 'system') 側の走査とサニタイズ（070 M4 / 台帳 #74）
  if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
    const located = locateMessagesArrayAndElements(bodyText)
    if (located && located.elementSpans.length === parsed.messages.length) {
      // 後ろから置換して前方のインデックスを狂わせない、または 1 件ずつ offset 追従
      for (let i = parsed.messages.length - 1; i >= 0; i--) {
        const msg = parsed.messages[i]
        if (!msg || typeof msg !== 'object') continue
        const msgObj = msg as { role?: unknown; content?: unknown }
        if (msgObj.role !== 'system') continue

        const candidates = extractTextCandidates(msgObj.content)
        for (const c of candidates) {
          const found = findGenuineEnvSection(c.text)
          if (found !== null) {
            anySectionFound = true
            const { text: sanitized, info } = sanitizeSectionText(found, requestModel)
            for (const p of info.strippedPatterns) {
              if (!combinedStrippedPatterns.includes(p)) combinedStrippedPatterns.push(p)
            }
            if (info.identityRemoved) combinedIdentityRemoved = true
            if (info.identityMatched) combinedIdentityMatched = true

            if (sanitized !== found) {
              const elemSpan = located.elementSpans[i]
              const elemRaw = bodyText.slice(elemSpan.start, elemSpan.end)
              const escapedOriginal = JSON.stringify(found).slice(1, -1)
              const escapedSanitized = JSON.stringify(sanitized).slice(1, -1)

              const idxWithinElem = elemRaw.indexOf(escapedOriginal)
              if (idxWithinElem === -1 || elemRaw.indexOf(escapedOriginal, idxWithinElem + 1) !== -1) {
                // 要素内で見つからないか一意でない場合は fail-open
                return {
                  body: rawBody,
                  info: {
                    changed: false,
                    strippedPatterns: combinedStrippedPatterns,
                    identityRemoved: combinedIdentityRemoved,
                    identityMatched: combinedIdentityMatched,
                    skippedReason: 'escaped_section_not_found_in_raw_body'
                  }
                }
              }

              const newElemRaw =
                elemRaw.slice(0, idxWithinElem) +
                escapedSanitized +
                elemRaw.slice(idxWithinElem + escapedOriginal.length)

              bodyText =
                bodyText.slice(0, elemSpan.start) +
                newElemRaw +
                bodyText.slice(elemSpan.end)

              changed = true
            }
          }
        }
      }
    }
  }

  // 2. system 側の走査とサニタイズ（既存経路 + カタログ行除去）
  if (parsed.system !== undefined) {
    const systemCandidates = extractTextCandidates(parsed.system)
    for (const c of systemCandidates) {
      const found = findSystemCatalogSection(c.text)
      if (found !== null) {
        anySectionFound = true
        const { text: sanitized, info } = sanitizeSectionText(found, requestModel)
        for (const p of info.strippedPatterns) {
          if (!combinedStrippedPatterns.includes(p)) combinedStrippedPatterns.push(p)
        }
        if (info.identityRemoved) combinedIdentityRemoved = true
        if (info.identityMatched) combinedIdentityMatched = true

        if (sanitized !== found) {
          // system フィールド全体のアンカー: "system":<systemSerialized>
          const SYSTEM_KEY_TOKEN = '"system":'
          const systemSerialized = JSON.stringify(parsed.system)
          const anchoredNeedle = SYSTEM_KEY_TOKEN + systemSerialized
          const rep = replaceSliceInAnchor(
            bodyText,
            anchoredNeedle,
            found,
            sanitized,
            'system_field_anchor_not_unique_in_raw_body'
          )
          if (!rep.success) {
            return {
              body: rawBody,
              info: {
                changed: false,
                strippedPatterns: combinedStrippedPatterns,
                identityRemoved: combinedIdentityRemoved,
                identityMatched: combinedIdentityMatched,
                skippedReason: rep.reason
              }
            }
          }
          bodyText = rep.newBodyText
          changed = true
        }
      }
    }
  }

  if (!anySectionFound) {
    return {
      body: rawBody,
      info: {
        changed: false,
        strippedPatterns: [],
        identityRemoved: false,
        identityMatched: false,
        skippedReason: 'no_environment_section_found'
      }
    }
  }

  return {
    body: changed ? Buffer.from(bodyText, 'utf8') : rawBody,
    info: {
      changed,
      strippedPatterns: combinedStrippedPatterns,
      identityRemoved: combinedIdentityRemoved,
      identityMatched: combinedIdentityMatched
    }
  }
}

/** リクエスト生バイトから `model` フィールドを読み取る（JSON 全体を解釈済みならそちらを使い、
 *  未解釈の生バイトのみ持っている呼び出し元向けの軽量フォールバック）。 */
export function readRequestModel(rawBody: Buffer): string | null {
  try {
    const head = rawBody.subarray(0, 8192).toString('utf8')
    const m = /"model"\s*:\s*"([^"]{1,80})"/.exec(head)
    return m ? m[1] : null
  } catch {
    return null
  }
}
