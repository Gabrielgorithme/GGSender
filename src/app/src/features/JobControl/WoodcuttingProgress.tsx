/*
 * GGSender: upstream draws a router bit cutting through a block of wood here.
 * Removed. ProgressArea already shows the percentage above this spot, so this
 * component only keeps the space (and its name and props, so the two places
 * that use it are untouched).
 */
type WoodcuttingProgressProps = {
    percentage: number;
    isPaused?: boolean;
};

const WoodcuttingProgress = (_props: WoodcuttingProgressProps) => {
    return <div className="w-full h-12" aria-hidden="true" />;
};

export default WoodcuttingProgress;
