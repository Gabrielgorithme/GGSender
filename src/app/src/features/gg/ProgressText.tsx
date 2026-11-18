/*
 * GGSender addition (not part of upstream gSender).
 *
 * Job progress as text over the 3D view: the percentage and the time left,
 * with no box behind them. Upstream draws them in a bordered box above a
 * router-bit animation; the animation was removed in 0.1.x and left the box
 * empty. A soft halo in the page's background colour keeps the text readable
 * over the toolpath.
 */
import { ReactNode } from 'react';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from 'app/components/shadcn/Tooltip';

export const TEXT_HALO =
    '[text-shadow:0_0_3px_rgb(255_255_255),0_0_6px_rgb(255_255_255)] dark:[text-shadow:0_0_3px_rgb(0_0_0),0_0_6px_rgb(0_0_0)]';

interface Props {
    percentage: number; // 0-100, already rounded down
    isFinalizing: boolean;
    time: ReactNode; // upstream's formatted time left
    finishTime: string; // shown on hover
}

export const ProgressText = ({ percentage, isFinalizing, time, finishTime }: Props) => (
    <div
        className={`flex flex-row items-end justify-center gap-5 text-gray-900 dark:text-gray-100 ${TEXT_HALO}`}
        data-testid="gg-progress-text"
    >
        <div className="flex flex-row items-end whitespace-nowrap" data-testid="gg-progress-percent">
            <span className="font-bold text-2xl">{percentage}</span>
            <span className="text-lg">%</span>
        </div>
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <div className="flex flex-row items-end gap-1 whitespace-nowrap" data-testid="gg-progress-remaining">
                        {isFinalizing ? (
                            <span className="text-lg">Finalizing</span>
                        ) : (
                            <>
                                {time}
                                <span className="text-sm mb-0.5 ml-1">remaining</span>
                            </>
                        )}
                    </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-64">{finishTime}</TooltipContent>
            </Tooltip>
        </TooltipProvider>
    </div>
);

export default ProgressText;
