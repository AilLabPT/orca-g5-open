import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentMessageTarget } from '@/lib/agent-session/messaging/agent-message-target'
import { revealAgentTerminal } from '@/components/native-chat/selection-quotes/native-chat-workspace-selection'

/** Says a note sits unsent in an agent's terminal; `toastId` replaces that send's pending toast. */
export function showNotePastedToast(args: {
  worktreeId: string
  target: AgentMessageTarget
  agentLabel: string
  toastId?: string | number
}): void {
  const { worktreeId, target, agentLabel, toastId } = args
  toast.info(
    translate(
      'components.agentNotes.pastedPressEnter',
      'Note pasted into {{agent}}. Press Enter there to send.',
      { agent: agentLabel }
    ),
    {
      ...(toastId === undefined ? {} : { id: toastId }),
      duration: 8000,
      ...(target.kind === 'terminal'
        ? {
            action: {
              label: translate('resourceManager.pty.goToTerminal', 'Go to terminal'),
              onClick: () => revealAgentTerminal(worktreeId, target)
            }
          }
        : {})
    }
  )
}
