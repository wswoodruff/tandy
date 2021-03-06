'use strict';
/**
 * Module dependencies
 */

const _ = require('lodash');
const Call = require('call');
const Hoek = require('hoek');

const Tandys = {
    create   : require('./actions/create'),
    find     : require('./actions/find'),
    findById : require('./actions/findById'),
    update   : require('./actions/update'),
    destroy  : require('./actions/destroy'),
    populate : require('./actions/populate'),
    add      : require('./actions/add'),
    remove  : require('./actions/remove')
};

const internals = {};

internals.defaults = {

    actAsUser: false,
    userUrlPrefix: 'user', // this is in the url in lieu of /users/{id}
    userModel: 'Users', // since it's not in the url
    userIdProperty: 'id', // on auth credentials
    prefix: '',
    _private: {
        actAsUserModifiedPath: false,
        count: false
    }

};

exports.register = (server, options, next) => {

    server.dependency('schwifty');

    server.handler('tandy', (route, handlerOptions) => {

        // handlerOptions come user-defined in route definition
        // nothing should override these!
        const thisRouteOpts = _.cloneDeep(internals.defaults);

        // Plugin-level user-defined options
        _.merge(thisRouteOpts, options);

        // Route-level user-defined options
        _.merge(thisRouteOpts, handlerOptions);

        // Route-level info (should not override plugin options & handler options)
        internals.setOptionsFromRouteInfo(route, thisRouteOpts);

        Hoek.assert(thisRouteOpts.model, 'Unable to determine model for route ' + route.path);

        //We want to allow for Model || model
        let Model = {};
        Model = server.models(true)[thisRouteOpts.model];

        if (!Model) {
            const capitalizedModel = thisRouteOpts.model.charAt(0).toUpperCase() + thisRouteOpts.model.slice(1);
            Model = server.models(true)[capitalizedModel];
        }

        Hoek.assert(Model, 'Model `' + thisRouteOpts.model + '` must exist to build route.');

        // Set associations now that the model is locked-down
        _.defaults(thisRouteOpts, { associations: Model.relationMappings });

        const tandy = internals.determineTandy(route, thisRouteOpts);

        return tandy(route, thisRouteOpts);
    });

    next();
};

exports.register.attributes = {
    pkg: require('../package.json')
};

internals.Router = new Call.Router({});

internals.determineTandy = (route, thisRouteOpts) => {

    const method = route.method;
    let path = route.path;

    path = internals.normalizePath(path, thisRouteOpts);

    const pathInfo = internals.Router.analyze(path);
    const pathSegments = pathInfo.segments.length;
    let err;

    let countIsOkay = false;
    let tandy;

    switch (method) {

        case 'post':

            if (pathSegments === 1 && pathInfo.segments[0].literal) {

                // Create
                tandy = Tandys.create;
            }
            else if (pathSegments === 2 && pathInfo.params.length === 1) {

                // Patched update
                tandy = Tandys.update;
            }
            else if (pathSegments === 3 && pathInfo.params.length === 1 ) {

                // Create and add to relation
                tandy = Tandys.add;
            }
            else {
                err = new Error('This ' + method + ' route does not match a Tandy pattern.');
            }
            break;

        case 'patch':

            if (pathSegments === 2 && pathInfo.params.length === 1) {

                // Patched update
                tandy = Tandys.update;
            }
            else {
                err = new Error('This ' + method + ' route does not match a Tandy pattern.');
            }
            break;

        case 'put':

            if (pathSegments === 4 && pathInfo.params.length === 2) {

                // Add to a relation
                tandy = Tandys.add;
            }
            else {
                err = new Error('This ' + method + ' route does not match a Tandy pattern.');
            }
            break;

        case 'get':

            if (pathSegments === 1 && pathInfo.segments[0].literal) {

                countIsOkay = true;
                // Find with criteria
                tandy = Tandys.find;

            }
            else if (pathSegments === 2 && pathInfo.params.length === 1) {
                // Find one by id
                tandy = Tandys.findById;

            }
            else if (pathSegments === 3 &&
                pathInfo.params.length === 1 &&
                pathInfo.segments[2].literal) {   // association

                countIsOkay = true;

                // Get associated records
                tandy = Tandys.populate;

            }
            else if (pathSegments === 4 &&
                pathInfo.segments[2].literal &&   // association
                pathInfo.params.length === 2) {

                // Check for an association between records
                tandy = Tandys.populate;

            }
            else {
                err = new Error('This ' + method + ' route does not match a Tandy pattern.');
            }

            break;

        case 'delete':
            if (pathSegments === 2 && pathInfo.params.length === 1) {

                tandy = Tandys.destroy;

            }
            else if (pathSegments === 4 &&
                pathInfo.segments[2].literal &&   // association
                pathInfo.params.length === 2) {

                tandy = Tandys.remove;

            }
            else {
                err = new Error('This ' + method + ' route does not match a Tandy pattern.');
            }

            break;

        default:
            err = new Error('Method isn\'t a Tandy.  Must be POST, GET, DELETE, PUT, or PATCH.');
            break;
    }

    // Only allow counting on find and array populate
    if (thisRouteOpts._private.count && !countIsOkay) {
        err = new Error('This tandy can\'t count!');
    }

    if (err) {
        throw err;
    }
    else {
        return tandy;
    }

};

internals.setOptionsFromRouteInfo = (route, thisRouteOpts) => {

    const routeInfo = {};

    const path = internals.normalizePath(route.path, thisRouteOpts);
    const pathInfo = internals.Router.analyze(path);
    const pathSegments = pathInfo.segments.length;
    Hoek.assert(pathSegments <= 4, 'Number of path segments should be between 1 and 4.');

    switch (pathSegments) {
        case 4:
            routeInfo.associatedPkName = pathInfo.params[1];
        case 3:
            routeInfo.associationAttr = pathInfo.segments[2].literal;
        case 2:
            routeInfo.pkName = pathInfo.params[0];
        case 1:
            routeInfo.model = pathInfo.segments[0].literal;
    }
    _.defaults(thisRouteOpts, routeInfo);

};

internals.normalizePath = (path, thisRouteOpts) => {

    Hoek.assert(_.isString(thisRouteOpts.userUrlPrefix) || !thisRouteOpts.userUrlPrefix, 'Option userUrlPrefix should only have a string or a falsy value.');
    Hoek.assert(_.isString(thisRouteOpts.userModel) || !thisRouteOpts.userModel, 'Option userModel should only have a string or a falsy value.');

    if (internals.pathEndsWith(path, '/count')) {
        thisRouteOpts._private.count = true;
        path = internals.removeSuffixFromPath(path, '/count');
    }

    // Deal with prefix option
    path = internals.removePrefixFromPath(path, thisRouteOpts.prefix);

    // Deal with user creds options.
    if (thisRouteOpts.actAsUser &&
        thisRouteOpts.userUrlPrefix &&
        thisRouteOpts.userModel &&
        internals.pathBeginsWith(path, thisRouteOpts.userUrlPrefix)) {

        thisRouteOpts._private.actAsUserModifiedPath = true;

        // Transform path to seem like it's of the form /users/{userId}...
        path = internals.removePrefixFromPath(path, thisRouteOpts.userUrlPrefix);

        if (internals.pathBeginsWith(path, '/{id}')) {
            path = '/' + thisRouteOpts.userModel + path;
        }
        else {
            path = '/' + thisRouteOpts.userModel + '/{id}' + path;
        }
    }

    return path;
};

internals.pathEndsWith = (path, needle) => {

    if (path.indexOf(needle) !== -1 && path.indexOf(needle) === path.length - needle.length) {
        return true;
    }
    return false;
};

internals.removeSuffixFromPath = (path, suffix) => {

    return path.slice(0, path.length - suffix.length);
};

internals.pathBeginsWith = (path, needle) => {

    // Remove trailing slashes from needle
    needle = needle.replace(/\/+$/, '');

    // path begins with needle
    const softBegins = (path.indexOf(needle) === 0);

    if (!softBegins){
        return false;
    }

    // Assuming path begins with needle,
    // make sure it takes up enitre query parts.
    // We check this by seeing if removing needle would leave an empty string (they have equal lengths)
    // or if removing needle would leave a '/' as the first character in the newly constructed path.
    const hardBegins = (path.length === needle.length) || path[needle.length] === '/';

    if (!hardBegins) {
        return false;
    }
    // Passed the tests
    return true;

};

internals.removePrefixFromPath = (path, prefix) => {

    Hoek.assert(_.isString(path), 'Path parameter should be a string');
    Hoek.assert(_.isString(prefix), 'Prefix parameter should be a string or falsy.');
    // Remove trailing slashes from prefix
    prefix = prefix.replace(/\/+$/, '');

    return path.slice(prefix.length);
};
