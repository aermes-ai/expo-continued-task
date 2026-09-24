require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoContinuedTask'
  s.version        = package['version']
  s.summary        = package['description']
  s.license        = { :type => 'MIT' }
  s.homepage       = 'https://github.com/aermes-ai/expo-continued-task'
  s.authors        = { 'Aermes' => 'dev@aermes.ai' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :path => '.' }
  s.source_files   = 'ios/**/*.{swift,h,m}'
  # Declared, not borrowed: BackgroundTasks for the continued task; Network for the debug log's
  # NWPathMonitor (DebugLogLifecycle.swift).
  s.frameworks     = 'UIKit', 'BackgroundTasks', 'Network'
  s.dependency 'ExpoModulesCore'
  s.swift_version  = '5.4'
end
