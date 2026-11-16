/*
 * GGSender addition (not part of upstream gSender).
 * Asked when a program requests the tool recorded as already loaded.
 */
import { Confirm } from 'app/components/ConfirmationDialog/ConfirmationDialogLib';

interface SameToolPromptOptions {
    tool: string | null;
    since: number | null;
    comment?: string;
}

export const formatSince = (since: number | null): string => {
    if (!since) {
        return '';
    }
    const date = new Date(since);
    const sameDay = date.toDateString() === new Date().toDateString();
    const time = date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
    });
    return sameDay ? `today at ${time}` : `${date.toLocaleDateString()} at ${time}`;
};

/**
 * @returns true to keep the loaded tool and continue, false to run the
 *          tool change routine
 */
export const askSameTool = ({
    tool,
    since,
    comment = '',
}: SameToolPromptOptions): Promise<boolean> => {
    return new Promise((resolve) => {
        const when = formatSince(since);
        const content = (
            <div>
                <p>
                    The program asks for <b>T{tool}</b>, which is recorded as
                    the tool already in the spindle
                    {when ? ` (set ${when})` : ''}.
                </p>
                <p>
                    Continue with it, without a tool change or probing? Work Z
                    is left exactly as it is. If the recorded tool is wrong,
                    run the tool change routine instead.
                </p>
                {comment && (
                    <p>
                        Comment: <b>{comment}</b>
                    </p>
                )}
            </div>
        );

        Confirm({
            title: `T${tool} Already Loaded`,
            content,
            confirmLabel: 'Continue, No Tool Change',
            cancelLabel: 'Run Tool Change Routine',
            onConfirm: () => resolve(true),
            onClose: () => resolve(false),
        });
    });
};
