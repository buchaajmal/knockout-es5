/*!
 * Knockout ES5 plugin - https://github.com/SteveSanderson/knockout-es5
 * Copyright (c) Steve Sanderson
 * MIT license
 */

(function(global, undefined) {
    'use strict';

    // A function that returns a new ES6-compatible WeakMap instance (using ES5 shim if needed).
    // Instantiated by prepareExports, accounting for which module loader is being used.
    var weakMapFactory;

    // Model tracking
    // --------------
    //
    // This is the central feature of Knockout-ES5. We augment model objects by converting properties
    // into ES5 getter/setter pairs that read/write an underlying Knockout observable. This means you can
    // use plain JavaScript syntax to read/write the property while still getting the full benefits of
    // Knockout's automatic dependency detection and notification triggering.
    //
    // For comparison, here's Knockout ES3-compatible syntax:
    //     var firstNameLength = myModel.user().firstName().length; // Read a value
    //     myModel.user().firstName('Bert'); // Write a value
    //
    // ... versus Knockout-ES5 syntax:
    //     var firstNameLength = myModel.user.firstName.length; // Read a value
    //     myModel.user.firstName = 'Bert'; // Write a value

    // ko.track(model) converts each property on the given model object into a getter/setter pair that
    // wraps a Knockout observable. Optionally specify an array of property names to wrap; otherwise we
    // wrap all properties. If any of the properties are already observables, we replace them with
    // ES5 getter/setter pairs that wrap your original observable instances.
    //
    // By design, this does *not* recursively walk child object properties, because making literally
    // everything everywhere independently observable is usually unhelpful. When you do want to track
    // child object properties independently, define your own class for those child objects and put
    // a separate ko.track call into its constructor --- this gives you far more control.
    function track(obj, propertyNames) {
        if (!obj || typeof obj !== 'object') {
            throw new Error('When calling ko.track, you must pass an object as the first parameter.');
        }

        var ko = this;
        propertyNames = propertyNames || Object.getOwnPropertyNames(obj);

        propertyNames.forEach(function(propertyName) {
            var origValue = obj[propertyName],
                isArray = origValue instanceof Array,
                observable = ko.isObservable(origValue) ? origValue
                                              : isArray ? ko.observableArray(origValue)
                                                        : ko.observable(origValue);

            Object.defineProperty(obj, propertyName, {
                configurable: true,
                enumerable: true,
                get: observable,
                set: ko.isWriteableObservable(observable) ? observable : undefined
            });

            getAllObservablesForObject(obj, true)[propertyName] = observable;

            if (isArray) {
                notifyWhenPresentOrFutureArrayValuesMutate(ko, observable);
            }
        });

        return obj;
    }

    // Lazily created by getAllObservablesForObject below. Has to be created lazily because the
    // WeakMap factory isn't available until the module has finished loading (may be async).
    var objectToObservableMap;

    // Gets or creates the hidden internal key-value collection of observables corresponding to
    // properties on the model object.
    function getAllObservablesForObject(obj, createIfNotDefined) {
        if (!objectToObservableMap) {
            objectToObservableMap = weakMapFactory();
        }

        var result = objectToObservableMap.get(obj);
        if (!result && createIfNotDefined) {
            result = {};
            objectToObservableMap.set(obj, result);
        }
        return result;
    }

    // Array handling
    // --------------
    //
    // Arrays are special, because unlike other property types, they have standard mutator functions
    // (push/pop/splice/etc.) and it's desirable to trigger a change notification whenever one of
    // those mutator functions is invoked.
    //
    // Traditionally, Knockout handles this by putting special versions of push/pop/etc. on observable
    // arrays that mutate the underlying array and then trigger a notification. That approach doesn't
    // work for Knockout-ES5 because properties now return the underlying arrays, so the mutator runs
    // in the context of the underlying array, not any particular observable:
    //
    //     myModel.someCollection.push('New value'); // Operates on the underlying array value
    //
    // To solve this, Knockout-ES5 detects array values, and modifies them as follows:
    //  1. Associates a hidden subscribable with each array instance that it encounters
    //  2. Intercepts standard mutators (push/pop/etc.) and makes them trigger the subscribable
    // Then, for model properties whose values are arrays, the property's underlying observable
    // subscribes to the array subscribable, so it can trigger a change notification after mutation.

    // Given an observable that underlies a model property, watch for any array value that might
    // be assigned as the property value, and hook into its change events
    function notifyWhenPresentOrFutureArrayValuesMutate(ko, observable) {
        var watchingArraySubscription = null;
        ko.computed(function () {
            // Unsubscribe to any earlier array instance
            if (watchingArraySubscription) {
                watchingArraySubscription.dispose();
                watchingArraySubscription = null;
            }

            // Subscribe to the new array instance
            var newArrayInstance = observable();
            if (newArrayInstance instanceof Array) {
                watchingArraySubscription = startWatchingArrayInstance(ko, observable, newArrayInstance);
            }
        });
    }

    // Listens for array mutations, and when they happen, cause the observable to fire notifications.
    // This is used to make model properties of type array fire notifications when the array changes.
    // Returns a subscribable that can later be disposed.
    function startWatchingArrayInstance(ko, observable, arrayInstance) {
        var subscribable = getSubscribableForArray(ko, arrayInstance);
        return subscribable.subscribe(observable);
    }

    // Lazily created by getSubscribableForArray below. Has to be created lazily because the
    // WeakMap factory isn't available until the module has finished loading (may be async).
    var arraySubscribablesMap;

    // Gets or creates a subscribable that fires after each array mutation
    function getSubscribableForArray(ko, arrayInstance) {
        if (!arraySubscribablesMap) {
            arraySubscribablesMap = weakMapFactory();
        }

        var subscribable = arraySubscribablesMap.get(arrayInstance);
        if (!subscribable) {
            subscribable = new ko.subscribable();
            arraySubscribablesMap.set(arrayInstance, subscribable);
            wrapStandardArrayMutators(arrayInstance, subscribable);
        }

        return subscribable;
    }

    // After each array mutation, fires a notification on the given subscribable
    function wrapStandardArrayMutators(arrayInstance, subscribable) {
        ['pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'].forEach(function(fnName) {
            var origMutator = arrayInstance[fnName];
            arrayInstance[fnName] = function() {
                var result = origMutator.apply(this, arguments);
                subscribable.notifySubscribers(this);
                return result;
            };
        });
    }

    // Static utility functions
    // ------------------------
    //
    // Since Knockout-ES5 sets up properties that return values, not observables, you can't
    // trivially subscribe to the underlying observables (e.g., someProperty.subscribe(...)),
    // or tell them that object values have mutated, etc. To handle this, we set up some
    // extra utility functions that can return or work with the underlying observables.

    // Returns the underlying observable associated with a model property (or null if the
    // model or property doesn't exist, or isn't associated with an observable). This means
    // you can subscribe to the property, e.g.:
    //     ko.getObservable(model, 'propertyName').subscribe(function(newValue) { ... });
    function getObservable(obj, propertyName) {
        if (!obj || typeof obj !== 'object') {
            return null;
        }

        var allObservablesForObject = getAllObservablesForObject(obj, false);
        return (allObservablesForObject && allObservablesForObject[propertyName]) || null;
    }

    // Causes a property's associated observable to fire a change notification. Useful when
    // the property value is a complex object and you've modified a child property.
    function valueHasMutated(obj, propertyName) {
        var observable = getObservable(obj, propertyName);

        if (observable) {
            observable.valueHasMutated();
        }
    }

    // Module initialisation
    // ---------------------
    //
    // When this script is first evaluated, it works out what kind of module loading scenario
    // it is in (Node.js or a browser <script> tag), stashes a reference to its dependencies
    // (currently that's just the WeakMap shim), and then finally attaches itself to whichever
    // instance of Knockout.js it can find.

    // Extends a Knockout instance with Knockout-ES5 functionality
    function attachToKo(ko) {
        ko.track = track;
        ko.getObservable = getObservable;
        ko.valueHasMutated = valueHasMutated;
    }

    // Determines which module loading scenario we're in, grabs dependencies, and attaches to KO
    function prepareExports() {
        if (typeof module !== 'undefined') {
            // Node.js case - load KO and WeakMap modules synchronously
            var ko = require('knockout'),
                WM = require('weakmap');
            attachToKo(ko);
            weakMapFactory = function() { return new WM(); };
            module.exports = ko;
        } else if ('ko' in global) {
            // Non-module case - attach to the global instance, and assume a global WeakMap instance
            attachToKo(global.ko);
            weakMapFactory = function() { return new global.WeakMap(); };
        }
    }

    prepareExports();

})(this);
