export function isControlMessage(value) {
    return typeof value === 'object' && value !== null && 'type' in value;
}
