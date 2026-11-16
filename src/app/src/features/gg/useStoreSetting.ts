/*
 * GGSender addition (not part of upstream gSender).
 * A gSender setting, re-read whenever the settings store changes.
 */
import { useEffect, useState } from 'react';
import store from 'app/store';

export const useStoreSetting = <T,>(key: string, fallback: T): T => {
    const [value, setValue] = useState<T>(() => store.get(key, fallback));
    useEffect(() => {
        const onChange = () => setValue(store.get(key, fallback));
        store.on('change', onChange);
        onChange();
        return () => {
            store.removeListener('change', onChange);
        };
        // fallback is a constant at every call site
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    return value;
};
