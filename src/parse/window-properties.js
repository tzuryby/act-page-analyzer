import _ from 'lodash';

export const getNativeWindowProperties = async (page) => {
    const keys = await page.evaluate(() => Object.keys(window)) // eslint-disable-line
    // Other concurrent worker might have done the same in the meantime
    const nativeWindowsProperties = {};
    _.each(keys, (key) => {
        nativeWindowsProperties[key] = true;
    });
    return nativeWindowsProperties;
};

// Evaluate window properties, save content for variables that are not function
export default function evalWindowProperties(properties) {
    const result = {};
    let cache = [];
    properties.forEach((property) => {
        const propertyContent = window[property] // eslint-disable-line
        switch (typeof propertyContent) {
        // Skip functions, used switch for future improvements
        case 'function':
            result[property] = 'function';
            break;
        default:
            try {
                // remove circular references and functions from variable content
                result[property] = JSON.parse(JSON.stringify(propertyContent, (key, value) => {
                    if (typeof value === 'function') {
                        return 'function';
                    }
                    if (typeof value === 'object' && value !== null) {
                        if (cache.indexOf(value) !== -1) {
                            return null;
                        }
                        cache.push(value);
                    }
                    return value;
                }));
            } catch (err) {
                result[property] = err;
            }
        }
    });
    cache = null;
    return result;
}
