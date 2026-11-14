/*
 * GGSender: upstream draws a router bit cutting through a block of wood here.
 * Replaced by a plain progress bar (the percentage is already shown above it
 * by ProgressArea). The component keeps its name and props so
 * the two places that use it (job progress, SD card progress) are untouched.
 */
type WoodcuttingProgressProps = {
    percentage: number;
    isPaused?: boolean;
};

const WoodcuttingProgress = ({
    percentage,
    isPaused = false,
}: WoodcuttingProgressProps) => {
    const value = Number.isFinite(Number(percentage))
        ? Math.min(100, Math.max(0, Number(percentage)))
        : 0;

    return (
        <div className="relative w-full h-12 flex items-center">
            <div
                className="relative w-full h-5 rounded-md overflow-hidden bg-gray-200 dark:bg-dark-darker ring-1 ring-gray-300 dark:ring-gray-600"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(value)}
            >
                <div
                    className={`h-full ${isPaused ? 'bg-amber-500' : 'bg-blue-500'}`}
                    style={{
                        width: `${value}%`,
                        transition: 'width 0.2s ease-out',
                    }}
                />
            </div>
        </div>
    );
};

export default WoodcuttingProgress;
