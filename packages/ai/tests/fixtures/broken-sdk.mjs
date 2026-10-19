// Fixture for loadModule: a module that resolves but throws while evaluating,
// like a broken or incompatible SDK install.
throw new Error('sdk exploded on load')
