import Storage, {Serializer} from './storage'
import { unstable_batchedUpdates } from 'react-dom'
import type { Dispatch, SetStateAction } from 'react'
import { useRef, useMemo, useEffect, useReducer, useCallback, useLayoutEffect } from 'react'

// `activeHooks` holds all active hooks. we use the array to update all hooks with the same key —
// calling `setValue` of one hook triggers an update for all other hooks with the same key
const activeHooks = new Set<{
    key: string
    forceUpdate: () => void
}>()

// - `useLocalStorageState()` return type
// - first two values are the same as `useState`
export type LocalStorageState<T> = [
    T,
    Dispatch<SetStateAction<T>>,
    {
        isPersistent: boolean
        removeItem: () => void
    },
]

export default function useLocalStorageState(
    key: string,
    options?: { ssr: boolean, serializer?: Serializer },
): LocalStorageState<unknown>
export default function useLocalStorageState<T>(
    key: string,
    options?: { ssr: boolean, serializer?: Serializer },
): LocalStorageState<T | undefined>
export default function useLocalStorageState<T>(
    key: string,
    options?: { defaultValue?: T; ssr?: boolean, serializer?: Serializer },
): LocalStorageState<T>
export default function useLocalStorageState<T = undefined>(
    key: string,
    options?: { defaultValue?: T; ssr?: boolean, serializer?: Serializer },
): LocalStorageState<T | undefined> {
    const defaultValue = options?.defaultValue
    const serializer: Serializer = options?.serializer ?? JSON

    // SSR support
    if (typeof window === 'undefined') {
        return [defaultValue, (): void => {}, { isPersistent: true, removeItem: (): void => {} }]
    }

    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useClientLocalStorageState(key, defaultValue, options?.ssr === true, serializer)
}

function useClientLocalStorageState<T>(
    key: string,
    defaultValue: T | undefined,
    ssr: boolean,
    serializer: Serializer
): LocalStorageState<T | undefined> {
    const storage = useMemo(() => new Storage(serializer), [serializer])

    const initialDefaultValue = useRef(defaultValue).current
    // `id` changes every time a change in the `localStorage` occurs
    const [id, forceUpdate] = useReducer((number) => number + 1, 0)
    const updateHooks = useCallback(() => {
        unstable_batchedUpdates(() => {
            // - it fixes "🐛 `setValue()` during render doesn't work":
            //   https://github.com/astoilkov/use-local-storage-state/issues/43
            forceUpdate()

            for (const hook of activeHooks) {
                if (hook.key === key) {
                    hook.forceUpdate()
                }
            }
        })
    }, [key])
    
    const setState = useCallback(
        (newValue: SetStateAction<T | undefined>): void => {
            storage.set(
                key,
                newValue instanceof Function
                    ? newValue(storage.get(key, initialDefaultValue))
                    : newValue,
            )

            updateHooks()
        },
        [key, updateHooks, initialDefaultValue, storage],
    )

    // - syncs change across tabs, windows, iframe's
    // - the `storage` event is called only in all tabs, windows, iframe's except the one that
    //   triggered the change
    useEffect(() => {
        const onStorage = (e: StorageEvent): void => {
            if (e.storageArea === localStorage && e.key === key) {
                forceUpdate()
            }
        }

        window.addEventListener('storage', onStorage)

        return (): void => window.removeEventListener('storage', onStorage)
    }, [key])

    // - adds this hook to the `activeHooks` array. see the `activeHooks` declaration above for a
    //   more detailed explanation
    useLayoutEffect(() => {
        const hook = { key, forceUpdate }
        activeHooks.add(hook)
        return (): void => {
            activeHooks.delete(hook)
        }
    }, [key])

    // - SSR support
    // - not inside a `useLayoutEffect` because this way we skip the calls to `useEffect()` and
    //   `useLayoutEffect()` for the first render (which also increases performance)
    // - inspired by: https://github.com/astoilkov/use-local-storage-state/pull/40
    // - related: https://github.com/astoilkov/use-local-storage-state/issues/39
    // - related: https://github.com/astoilkov/use-local-storage-state/issues/43
    const isFirstRenderRef = useRef(true)
    const isPossiblyHydrating = ssr && isFirstRenderRef.current
    isFirstRenderRef.current = false
    if (
        isPossiblyHydrating &&
        (Storage.data.has(key) || initialDefaultValue !== storage.get(key, initialDefaultValue))
    ) {
        forceUpdate()
    }

    // initial issue: https://github.com/astoilkov/use-local-storage-state/issues/26
    // issues that were caused by incorrect initial and secondary implementations:
    // - https://github.com/astoilkov/use-local-storage-state/issues/30
    // - https://github.com/astoilkov/use-local-storage-state/issues/33
    if (
        initialDefaultValue !== undefined &&
        !Storage.data.has(key) &&
        localStorage.getItem(key) === null
    ) {
        storage.set(key, initialDefaultValue)
    }

    return useMemo(
        () => [
            isPossiblyHydrating ? initialDefaultValue : storage.get(key, initialDefaultValue),
            setState,
            {
                isPersistent: isPossiblyHydrating || !Storage.data.has(key),
                removeItem(): void {
                    storage.remove(key)

                    updateHooks()
                },
            },
        ],

        // disabling eslint warning for the following reasons:
        // - `id` is needed because when it changes that means the data in `localStorage` has
        //   changed and we need to update the returned value. However, the eslint rule wants us to
        //   remove the `id` from the dependencies array.
        // - `defaultValue` never changes so we can skip it and reduce package size
        // - `setState` changes when `key` changes so we can skip it and reduce package size
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [id, key],
    )
}
