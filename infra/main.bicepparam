using './main.bicep'

param location = 'westeurope'
param appName = 'kinestream'
param environment = 'dev'
param jwtSecret = readEnvironmentVariable('JWT_SECRET', '')
