/**
 * skillProposalCollisionCard — golden 同名衝突パネルの純粋表示モデルおよび操作ディスパッチャ。
 *
 * CCPIT_066: 提案と golden の関係に応じた表示モデルの生成と、UI コールバックへの型安全な実行結線
 * （ジェネリック疎結合）を提供する。
 * 発注「golden 同名提案の正規ルート」: 状態は「手元と golden が同じか」ではなく
 * 「提案の中身が golden に入っているか」の 3 つ（反映済み／未反映／提案が古い）。
 * 一番目立つボタンは、中身がまだ入っていない提案では「合成して golden へ入れる」。
 */

export type GoldenCollisionCardAction =
  | 'composeGoldenMerge'
  | 'consultGoldenMerge'
  | 'markAsAdoptedMerged'

/** カードが扱う状態（衝突していない 'none' は、このカードを出さないので含めない） */
export type GoldenCollisionCardStatus = 'applied' | 'unapplied' | 'stale'

export interface GoldenCollisionCardButton {
  action: GoldenCollisionCardAction
  label: string
  variant: 'outline' | 'default'
}

export interface GoldenCollisionCardModel {
  status: GoldenCollisionCardStatus
  /** 反映済み（旧 isResolved と同値） */
  isResolved: boolean
  containerClassName: string
  iconName: 'alert-triangle' | 'check-circle-2'
  iconClassName: string
  title: string
  description: string
  buttons: GoldenCollisionCardButton[]
  /** 「統合済みとして採用済みにする」が、何も適用されないことの確認を要するか */
  markRequiresAck: boolean
  /** markRequiresAck のとき、確認欄に出す文面（反映済みなら空） */
  markAckText: string
}

type Translate = (ja: string, en: string) => string

const COMPOSE_LABEL = (L: Translate): string =>
  L('合成して golden へ入れる', 'Merge into the golden version (AI-assisted)')
const CONSULT_LABEL = (L: Translate): string =>
  L('golden 版との統合を Claude Code に相談', 'Consult Claude Code to merge with the golden version')
const MARK_LABEL = (L: Translate): string =>
  L('統合済みとして採用済みにする', 'Mark as adopted (merged)')

/**
 * 提案と golden の関係（status）と多言語化関数（L）から、カードの表示モデルを決定論的に導出する純関数。
 * 主ボタン（variant: 'default'）は 1 つだけ: 反映済みなら「採用済みにする」、それ以外は「合成して golden へ入れる」。
 */
export function getGoldenCollisionCardModel(
  status: GoldenCollisionCardStatus,
  L: Translate
): GoldenCollisionCardModel {
  if (status === 'applied') {
    return {
      status,
      isResolved: true,
      containerClassName: 'rounded border border-emerald-500/30 bg-emerald-500/10 p-3 space-y-2',
      iconName: 'check-circle-2',
      iconClassName: 'text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5',
      title: L('golden に反映済み', 'Already in the golden version'),
      description: L(
        'この提案の中身は golden に入っています。記録として「統合済みとして採用済みにする」を押して問題ありません（ファイルへの書込みは発生しません）。',
        'The contents of this proposal are already in the golden version. It is safe to click "Mark as adopted (merged)" to record this (no files will be written).'
      ),
      buttons: [
        { action: 'markAsAdoptedMerged', label: MARK_LABEL(L), variant: 'default' },
        { action: 'consultGoldenMerge', label: CONSULT_LABEL(L), variant: 'outline' }
      ],
      markRequiresAck: false,
      markAckText: ''
    }
  }

  const stale = status === 'stale'
  return {
    status,
    isResolved: false,
    containerClassName: 'rounded border border-amber-500/30 bg-amber-500/10 p-3 space-y-2',
    iconName: 'alert-triangle',
    iconClassName: 'text-amber-600 shrink-0 mt-0.5',
    title: stale
      ? L('golden 同名衝突（提案が古い）', 'Name collision with a golden skill (proposal is out of date)')
      : L('golden 同名衝突（未反映）', 'Name collision with a golden skill (not applied yet)'),
    description: stale
      ? L(
          'golden が提案の元にした版から進んでいます。そのままでは採用できません。「合成して golden へ入れる」を押すと、AI が今の golden に合わせて提案を作り直します。',
          'The golden version has moved on since this proposal was written, so it cannot be adopted as is. "Merge into the golden version" lets the AI rebuild the proposal on top of the current golden.'
        )
      : L(
          'この提案の中身はまだ golden に入っていません。golden 配布 skill と同名のため通常の採用はできません。「合成して golden へ入れる」を押すと、AI が提案を今の golden に合成して golden まで入れる手順を進めます。',
          'The contents of this proposal are not in the golden version yet. Normal adoption is blocked because the name matches a golden skill. "Merge into the golden version" lets the AI merge the proposal into the current golden and carry it through.'
        ),
    buttons: [
      { action: 'composeGoldenMerge', label: COMPOSE_LABEL(L), variant: 'default' },
      { action: 'consultGoldenMerge', label: CONSULT_LABEL(L), variant: 'outline' },
      { action: 'markAsAdoptedMerged', label: MARK_LABEL(L), variant: 'outline' }
    ],
    markRequiresAck: true,
    markAckText: L(
      'この操作は何も適用しません。提案の状態を「採用済み」にするだけで、提案の中身は golden に入りません。それでも採用済みにしますか。',
      'This applies nothing. It only marks the proposal as adopted; its contents will NOT be put into the golden version. Mark it as adopted anyway?'
    )
  }
}

/** 「？」ダイアログの 1 場面。 */
export interface GoldenCollisionHelpScene {
  key: 'applied' | 'unapplied' | 'stale' | 'multiple'
  title: string
  /** いまの状態 */
  situation: string
  /** 押すボタン */
  press: string
  /** そのボタンが何をして、何をしないか */
  effect: string
}

/**
 * 「？」ダイアログの文面。状態ごとに「いつ・どれを・押すと何が起きるか」を 1 場面ずつ返す純関数。
 * ボタンの表記は buttons のラベル（COMPOSE/CONSULT/MARK）と同じ文字列を使う。
 */
export function getGoldenCollisionHelp(L: Translate): GoldenCollisionHelpScene[] {
  const compose = COMPOSE_LABEL(L)
  const consult = CONSULT_LABEL(L)
  const mark = MARK_LABEL(L)
  return [
    {
      key: 'unapplied',
      title: L('未反映（提案の中身がまだ golden に入っていない）', 'Not applied (contents are not in golden yet)'),
      situation: L(
        '提案の元にした版は今の golden と同じで、提案の中身だけがまだ入っていません。',
        'The proposal was written against the current golden, but its contents are not in golden yet.'
      ),
      press: L(`「${compose}」を押します。`, `Press "${compose}".`),
      effect: L(
        `AI が提案を今の golden に合成し、検査したうえで、golden への反映（承認）まで進めます。「${mark}」は何も適用せず、提案の状態だけを変えます（確認が出ます）。「${consult}」は従来の相談で、書き込みは行いません。`,
        `The AI merges the proposal into the current golden, checks it, and carries it through to the golden approval. "${mark}" applies nothing and only changes the proposal's state (a confirmation appears). "${consult}" is the older consultation and writes nothing by itself.`
      )
    },
    {
      key: 'stale',
      title: L('提案が古い（golden が先へ進んでいる）', 'Out of date (golden has moved on)'),
      situation: L(
        '提案を書いた後で golden が変わっており、そのまま入れると golden 側の変更を巻き戻します。',
        'Golden changed after the proposal was written; applying it as is would roll those changes back.'
      ),
      press: L(`「${compose}」を押します。`, `Press "${compose}".`),
      effect: L(
        `AI が今の golden を土台に提案を作り直して合成します。「${mark}」は何も適用せず、提案の状態だけを変えます（確認が出ます）。`,
        `The AI rebuilds the proposal on top of the current golden and merges it. "${mark}" applies nothing and only changes the proposal's state (a confirmation appears).`
      )
    },
    {
      key: 'applied',
      title: L('反映済み（提案の中身が golden に入っている）', 'Applied (contents are already in golden)'),
      situation: L(
        'この提案の全ファイルが golden と同じ中身になっています。',
        'Every file of this proposal already matches the golden version.'
      ),
      press: L(`「${mark}」を押します。`, `Press "${mark}".`),
      effect: L(
        'ファイルは書き換えず、提案の状態を「採用済み」にして記録だけ閉じます。確認は出ません。',
        'No files are written; the proposal is just marked as adopted to close the record. No confirmation appears.'
      )
    },
    {
      key: 'multiple',
      title: L('同じ skill に提案が複数ある', 'Several proposals target the same skill'),
      situation: L(
        '同じファイルを丸ごと置き換える提案が 2 本以上あると、片方だけ入れるともう片方の変更が消えます。',
        'When two or more proposals each replace the same file wholesale, applying only one drops the other\'s changes.'
      ),
      press: L(`どの提案でも「${compose}」を押します。`, `Press "${compose}" on any of them.`),
      effect: L(
        '同じ skill 宛ての提案を 1 つに合成して入れます。合成せずに 1 本ずつ golden へ上げようとすると、黙って上書きせず止まります。',
        'Proposals for the same skill are merged into one and applied together. Trying to promote them one by one is stopped instead of silently overwriting.'
      )
    }
  ]
}

export interface GoldenCollisionActionCallbacks<T> {
  composeGoldenMerge: (proposal: T) => void | Promise<void>
  consultGoldenMerge: (proposal: T) => void | Promise<void>
  markAsAdoptedMerged: (proposal: T) => void | Promise<void>
}

export interface GoldenCollisionActionHandlers {
  composeGoldenMerge: () => void | Promise<void>
  consultGoldenMerge: () => void | Promise<void>
  markAsAdoptedMerged: () => void | Promise<void>
}

/**
 * selected と実コールバック群から handlers オブジェクトを構築する純粋アダプタ。
 */
export function createGoldenCollisionActionHandlers<T>(
  selected: T,
  callbacks: GoldenCollisionActionCallbacks<T>
): GoldenCollisionActionHandlers {
  return {
    composeGoldenMerge: () => callbacks.composeGoldenMerge(selected),
    consultGoldenMerge: () => callbacks.consultGoldenMerge(selected),
    markAsAdoptedMerged: () => callbacks.markAsAdoptedMerged(selected)
  }
}

/**
 * action 識別子に基づき適切なハンドラを確実に呼び出す純粋ディスパッチャ。
 */
export function dispatchGoldenCollisionAction(
  action: GoldenCollisionCardAction,
  handlers: GoldenCollisionActionHandlers
): void | Promise<void> {
  if (action === 'composeGoldenMerge') return handlers.composeGoldenMerge()
  if (action === 'consultGoldenMerge') return handlers.consultGoldenMerge()
  if (action === 'markAsAdoptedMerged') return handlers.markAsAdoptedMerged()
}

/**
 * アクション実行のワンストップエントリーポイント（アダプタ＋ディスパッチャ）。
 * ページからはこの 1 関数のみを呼び出し、selected の渡し間違いや取り違えを防ぐ。
 */
export function executeGoldenCollisionAction<T>(
  action: GoldenCollisionCardAction,
  selected: T,
  callbacks: GoldenCollisionActionCallbacks<T>
): void | Promise<void> {
  const handlers = createGoldenCollisionActionHandlers(selected, callbacks)
  return dispatchGoldenCollisionAction(action, handlers)
}
