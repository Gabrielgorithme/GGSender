import React, { useRef, useState } from 'react';

import { Axis } from 'app/features/DRO/utils/DRO.ts';
import { usePostHog } from '@posthog/react';
import { evaluateNumericInput } from 'app/lib/gg/expression';

export interface WCSInputProps {
    value: string;
    disabled?: boolean;
    movementHandler?: (t: string | number, s: Axis) => void;
    axis: Axis;
}

export function WCSInput({
    value = '0.00',
    disabled = false,
    movementHandler,
    axis,
}: WCSInputProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const posthog = usePostHog();
    // GGSender: set while the typed text is not a valid number or expression
    const [invalid, setInvalid] = useState(false);

    const onKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            // GGSender: the field accepts arithmetic ("12.5/2", "(120-6)/2")
            // and "*2" or "/2" applied to the current value. Upstream parsed
            // the text with Number() only. Nothing is sent if it is invalid.
            const inputValue = evaluateNumericInput(
                inputRef.current.value,
                value,
            );

            if (inputValue === null) {
                setInvalid(true);
                return;
            }

            setInvalid(false);
            inputRef.current.value = String(inputValue);
            movementHandler(inputValue, axis);
            posthog?.capture('manual_wcs_offset_updated', {
                axis,
                value: inputValue,
            });
            return;
        }
        if (e.key === 'Escape') {
            inputRef.current.blur();
            return;
        }
        if (invalid) {
            setInvalid(false);
        }
    };

    const onBlur = () => {
        setInvalid(false);
        inputRef.current.value = String(value);
    };

    return (
        <div
            key={`wcs-${axis}-${value}`}
            className="flex justify-center items-center"
        >
            <input
                // GGSender: "text" instead of "number" so operators can be
                // typed; inputMode keeps the numeric keypad on touch screens.
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                title="Type a value or a calculation, e.g. 12.5/2 or /2, then Enter"
                defaultValue={value}
                disabled={disabled}
                ref={inputRef}
                onBlur={onBlur}
                onKeyDown={onKeyPress}
                className={`text-xl font-bold flex items-center font-mono w-[9ch] p-0 m-0 text-center border-none bg-gray-100 outline-none focus:bg-white dark:bg-dark ${invalid ? 'text-red-500' : 'text-blue-500'}`}
                data-testid={`wcs-input-${axis}`}
            />
        </div>
    );
}
