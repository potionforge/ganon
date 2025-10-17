module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    'expo-network': '<rootDir>/src/__tests__/__mocks__/expo-network.ts'
  },
  testMatch: [
    '<rootDir>/src/**/__tests__/**/*.test.ts',
    '<rootDir>/src/**/?(*.)+(spec|test).[jt]s?(x)'
  ],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  transformIgnorePatterns: [
    'node_modules/(?!(expo-network|expo-modules-core)/)'
  ]
}; 